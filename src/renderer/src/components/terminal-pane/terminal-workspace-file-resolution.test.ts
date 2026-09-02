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
    const listFiles = vi.fn(async () => [
      'src/a/Foo.ts',
      'src/renderer/src/components/terminal-pane/TerminalContextMenu.test.tsx',
      'README.md'
    ])
    const result = await resolveWorkspaceFileByBasename({
      basename: 'TerminalContextMenu.test.tsx',
      worktreePath: WT,
      listFiles,
      now: 1000
    })
    expect(result).toBe(
      '/Users/me/repo/src/renderer/src/components/terminal-pane/TerminalContextMenu.test.tsx'
    )
    expect(listFiles).toHaveBeenCalledWith({ rootPath: WT })
  })

  it('returns null when multiple files share the basename (ambiguous, never guesses)', async () => {
    const listFiles = vi.fn(async () => ['a/index.ts', 'b/index.ts'])
    expect(
      await resolveWorkspaceFileByBasename({
        basename: 'index.ts',
        worktreePath: WT,
        listFiles,
        now: 1000
      })
    ).toBeNull()
  })

  it('returns null when no file matches', async () => {
    const listFiles = vi.fn(async () => ['a/x.ts'])
    expect(
      await resolveWorkspaceFileByBasename({
        basename: 'missing.ts',
        worktreePath: WT,
        listFiles,
        now: 1000
      })
    ).toBeNull()
  })

  it('caches the file list within the TTL and refetches once it expires', async () => {
    const listFiles = vi.fn(async () => ['a/Foo.ts'])
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      listFiles,
      now: 1000
    })
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      listFiles,
      now: 5000
    })
    expect(listFiles).toHaveBeenCalledTimes(1)
    await resolveWorkspaceFileByBasename({
      basename: 'Foo.ts',
      worktreePath: WT,
      listFiles,
      now: 1000 + 20_000
    })
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it('keys the cache by connection and forwards connectionId for SSH worktrees', async () => {
    const listFiles = vi.fn(async ({ connectionId }: { connectionId?: string }) =>
      connectionId === 'ssh-1' ? ['y/remote.ts'] : ['z/remote.ts']
    )
    const first = await resolveWorkspaceFileByBasename({
      basename: 'remote.ts',
      worktreePath: WT,
      connectionId: 'ssh-1',
      listFiles,
      now: 1
    })
    const second = await resolveWorkspaceFileByBasename({
      basename: 'remote.ts',
      worktreePath: WT,
      connectionId: 'ssh-2',
      listFiles,
      now: 1
    })
    const cachedFirst = await resolveWorkspaceFileByBasename({
      basename: 'remote.ts',
      worktreePath: WT,
      connectionId: 'ssh-1',
      listFiles,
      now: 1
    })
    expect(first).toBe('/Users/me/repo/y/remote.ts')
    expect(second).toBe('/Users/me/repo/z/remote.ts')
    expect(cachedFirst).toBe(first)
    expect(listFiles).toHaveBeenCalledTimes(2)
    expect(listFiles).toHaveBeenNthCalledWith(1, { rootPath: WT, connectionId: 'ssh-1' })
    expect(listFiles).toHaveBeenNthCalledWith(2, { rootPath: WT, connectionId: 'ssh-2' })
  })

  it('caches failed listings within the TTL without throwing', async () => {
    const listFiles = vi.fn(async () => {
      throw new Error('listing unavailable')
    })
    await expect(
      resolveWorkspaceFileByBasename({
        basename: 'x.ts',
        worktreePath: WT,
        listFiles,
        now: 1
      })
    ).resolves.toBeNull()
    await expect(
      resolveWorkspaceFileByBasename({
        basename: 'x.ts',
        worktreePath: WT,
        listFiles,
        now: 2
      })
    ).resolves.toBeNull()
    expect(listFiles).toHaveBeenCalledTimes(1)
    await expect(
      resolveWorkspaceFileByBasename({
        basename: 'x.ts',
        worktreePath: WT,
        listFiles,
        now: 20_000
      })
    ).resolves.toBeNull()
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

})
