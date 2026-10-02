import type { Stats } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSkillScanRoot } from './agent-skill-scan-roots'

/**
 * The one shape in this guard that no real filesystem on CI can produce: `lstat` on a WSL
 * ext4 symlink reached over the 9P redirector (`\\wsl.localhost\<distro>\home\...`) throws
 * **EISDIR** rather than answering. Everything else about the guard is exercised against real
 * links in `skill-linked-root-deletion.test.ts`; only the errno is faked here, and only
 * because reproducing it needs a mounted WSL distro no runner has.
 */

const { lstatMock } = vi.hoisted(() => ({ lstatMock: vi.fn() }))

// Only `lstat` is pinned; every other export stays real so nothing else changes behaviour.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  lstat: lstatMock
}))

// Imported after the mock on purpose: `vi.mock` is hoisted, so this binding gets the fake.
import { findSkillLinkedRootDeletions } from './skill-linked-root-deletion'

const ROOT = join('\\\\wsl.localhost', 'Ubuntu', 'home', 'dev', '.claude', 'skills')

/** Passing `roots` explicitly keeps the host's own home out, so `lstat` is the only input. */
const roots: AgentSkillScanRoot[] = [
  {
    id: 'home-claude',
    label: 'Claude home',
    path: ROOT,
    sourceKind: 'home',
    providers: ['claude'],
    owner: 'claude'
  }
]

function entry(kind: 'directory' | 'symlink'): Stats {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only isSymbolicLink() and isDirectory() off an lstat result, both of which this provides; no other Stats member is reachable from it.
  return {
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'directory'
  } as Stats
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fake`), { code })
}

function deletions() {
  return findSkillLinkedRootDeletions({ names: ['orca-cli'], roots, env: {} })
}

beforeEach(() => {
  lstatMock.mockReset()
})

describe('findSkillLinkedRootDeletions with a root lstat cannot answer for', () => {
  it('still guards a real directory when the root answers EISDIR instead of a link', async () => {
    lstatMock.mockImplementation((path: string) =>
      path === ROOT ? Promise.reject(errno('EISDIR')) : Promise.resolve(entry('directory'))
    )

    expect((await deletions()).map((deletion) => deletion.destinationPath)).toEqual([
      join(ROOT, 'orca-cli')
    ])
  })

  it('reports nothing when the root is unreadable and the destination is absent', async () => {
    // The bound on treating the unknown as a link: an unreadable root cannot skip a name
    // by itself, only alongside a destination that positively reads as a real directory.
    lstatMock.mockImplementation((path: string) =>
      Promise.reject(errno(path === ROOT ? 'EISDIR' : 'ENOENT'))
    )

    expect(await deletions()).toEqual([])
  })

  it('reports nothing when the destination inside it is a link, not a real directory', async () => {
    lstatMock.mockImplementation((path: string) =>
      path === ROOT ? Promise.reject(errno('EISDIR')) : Promise.resolve(entry('symlink'))
    )

    expect(await deletions()).toEqual([])
  })

  it('keeps ENOENT on the root meaning absent, not unknown', async () => {
    // A root nothing has created is the ordinary case and must stay silent, even though a
    // hypothetical directory beneath a missing root would otherwise read as at risk.
    lstatMock.mockImplementation((path: string) =>
      path === ROOT ? Promise.reject(errno('ENOENT')) : Promise.resolve(entry('directory'))
    )

    expect(await deletions()).toEqual([])
  })

  it('leaves a root that reads cleanly as a real directory alone', async () => {
    lstatMock.mockResolvedValue(entry('directory'))

    expect(await deletions()).toEqual([])
  })
})
