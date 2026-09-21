/**
 * Asymmetric `u` records used to cost one `fs.access` each — a 9p/network round trip per conflict on
 * a WSL or remote worktree. Porcelain v2 already carries the answer in the worktree mode (`mW`), so
 * the probe must not come back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const { accessMock } = vi.hoisted(() => ({ accessMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  access: accessMock
}))

import { parseUnmergedEntry } from './git-status-conflict-entries'

const WORKTREE = '/repo'

/** `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — `mW` is the working-tree mode. */
function unmergedLine(xy: string, modeWorktree: string, filePath: string): string {
  return `u ${xy} N... 100644 100644 100644 ${modeWorktree} aaa bbb ccc ${filePath}`
}

const ASYMMETRIC_KINDS = ['AU', 'UA', 'DU', 'UD'] as const

describe('parseUnmergedEntry', () => {
  beforeEach(() => {
    accessMock.mockReset()
    accessMock.mockRejectedValue(new Error('fs.access must not be reached for well-formed records'))
  })

  it('reads the working-tree mode instead of probing the filesystem', async () => {
    for (const xy of ASYMMETRIC_KINDS) {
      const absent = await parseUnmergedEntry(WORKTREE, unmergedLine(xy, '000000', 'gone.ts'))
      const present = await parseUnmergedEntry(WORKTREE, unmergedLine(xy, '100644', 'here.ts'))

      expect(absent?.status, xy).toBe('deleted')
      expect(present?.status, xy).toBe('modified')
    }

    // The regression this replaces: one probe per asymmetric row, serialised across the status poll.
    expect(accessMock).not.toHaveBeenCalled()
  })

  it('treats a symlink left in place of the conflicted file as present', async () => {
    const entry = await parseUnmergedEntry(WORKTREE, unmergedLine('UD', '120000', 'link.ts'))

    expect(entry?.status).toBe('modified')
    expect(accessMock).not.toHaveBeenCalled()
  })

  it('resolves the symmetric kinds from XY alone, whatever the working-tree mode says', async () => {
    const bothModified = await parseUnmergedEntry(WORKTREE, unmergedLine('UU', '000000', 'a.ts'))
    const bothAdded = await parseUnmergedEntry(WORKTREE, unmergedLine('AA', '000000', 'b.ts'))
    const bothDeleted = await parseUnmergedEntry(WORKTREE, unmergedLine('DD', '100644', 'c.ts'))

    expect(bothModified?.status).toBe('modified')
    expect(bothAdded?.status).toBe('modified')
    expect(bothDeleted?.status).toBe('deleted')
    expect(accessMock).not.toHaveBeenCalled()
  })

  it('drops submodule conflicts without probing', async () => {
    const line = 'u UU S... 160000 160000 160000 160000 aa bb cc vendor/sub'

    expect(await parseUnmergedEntry(WORKTREE, line)).toBeNull()
    expect(accessMock).not.toHaveBeenCalled()
  })

  it('keeps the working-tree probe as a fallback for a mode no real Git emits', async () => {
    accessMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const missing = await parseUnmergedEntry(WORKTREE, unmergedLine('UD', 'zzzzzz', 'weird-a.ts'))

    accessMock.mockResolvedValueOnce(undefined)
    const found = await parseUnmergedEntry(WORKTREE, unmergedLine('UD', '12345', 'weird-b.ts'))

    accessMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const unreadable = await parseUnmergedEntry(WORKTREE, unmergedLine('UD', '', 'weird-c.ts'))

    expect(missing?.status).toBe('deleted')
    expect(found?.status).toBe('modified')
    // Why: an ambiguous fs failure keeps the row visible rather than falsely reading as 'deleted'.
    expect(unreadable?.status).toBe('modified')
    expect(accessMock).toHaveBeenCalledTimes(3)
  })
})
