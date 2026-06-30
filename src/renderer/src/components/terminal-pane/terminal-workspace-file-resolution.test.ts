import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWorkspaceFileIndexCacheForTest,
  resolveWorkspaceFileByBasename
} from './terminal-workspace-file-resolution'

const WT = '/Users/me/repo'

afterEach(() => {
  __resetWorkspaceFileIndexCacheForTest()
})

describe('resolveWorkspaceFileByBasename', () => {
  it('resolves a bare filename to a unique nested workspace file (issue #5024)', async () => {
    const resolveUniqueFileByBasename = vi.fn(
      async () => 'src/renderer/src/components/terminal-pane/TerminalContextMenu.test.tsx'
    )
    const result = await resolveWorkspaceFileByBasename({
      basename: 'TerminalContextMenu.test.tsx',
      worktreePath: WT,
      resolveUniqueFileByBasename,
      now: 1000
    })
    expect(result).toBe(
      '/Users/me/repo/src/renderer/src/components/terminal-pane/TerminalContextMenu.test.tsx'
    )
    expect(resolveUniqueFileByBasename).toHaveBeenCalledWith({
      rootPath: WT,
      basename: 'TerminalContextMenu.test.tsx'
    })
  })

  it('returns null when multiple files share the basename (ambiguous, never guesses)', async () => {
    const resolveUniqueFileByBasename = vi.fn(async () => null)
    expect(
      await resolveWorkspaceFileByBasename({
        basename: 'index.ts',
        worktreePath: WT,
        resolveUniqueFileByBasename,
        now: 1000
      })
    ).toBeNull()
  })

  it('returns null when no file matches', async () => {
    const resolveUniqueFileByBasename = vi.fn(async () => null)
    expect(
      await resolveWorkspaceFileByBasename({
        basename: 'missing.ts',
        worktreePath: WT,
        resolveUniqueFileByBasename,
        now: 1000
      })
    ).toBeNull()
  })

  it('caches the basename result within the TTL and refetches once it expires', async () => {
    const resolveUniqueFileByBasename = vi.fn(async () => 'a/Foo.ts')
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      resolveUniqueFileByBasename,
      now: 1000
    })
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      resolveUniqueFileByBasename,
      now: 5000
    })
    expect(resolveUniqueFileByBasename).toHaveBeenCalledTimes(1)
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      resolveUniqueFileByBasename,
      now: 1000 + 20_000
    })
    expect(resolveUniqueFileByBasename).toHaveBeenCalledTimes(2)
  })

  it('keys the cache by connection and forwards connectionId for SSH worktrees', async () => {
    const remote = vi.fn(async () => 'y/remote.ts')
    const result = await resolveWorkspaceFileByBasename({
      basename: 'remote.ts',
      worktreePath: WT,
      connectionId: 'ssh-1',
      resolveUniqueFileByBasename: remote,
      now: 1
    })
    expect(result).toBe('/Users/me/repo/y/remote.ts')
    expect(remote).toHaveBeenCalledWith({
      rootPath: WT,
      basename: 'remote.ts',
      connectionId: 'ssh-1'
    })
  })

  it('returns null without throwing when the basename lookup fails', async () => {
    const resolveUniqueFileByBasename = vi.fn(async () => {
      throw new Error('listing unavailable')
    })
    expect(
      await resolveWorkspaceFileByBasename({
        basename: 'x.ts',
        worktreePath: WT,
        resolveUniqueFileByBasename,
        now: 1
      })
    ).toBeNull()
  })
})
