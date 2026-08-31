import { describe, expect, it, vi } from 'vitest'
import {
  openWorkspaceFilePathsInSplit,
  resolveWorkspaceFileOpenTarget,
  type WorkspaceFilePaneDropDeps
} from './workspace-file-pane-drop'

const WORKTREE_PATH = '/repo'

function makeDeps(
  overrides: Partial<WorkspaceFilePaneDropDeps> = {}
): WorkspaceFilePaneDropDeps & { openFile: ReturnType<typeof vi.fn> } {
  return {
    createEmptySplitGroup: vi.fn(() => 'new-group'),
    isDirectory: vi.fn(async () => false),
    openFile: vi.fn(),
    setActiveTabType: vi.fn(),
    ...overrides
  } as WorkspaceFilePaneDropDeps & { openFile: ReturnType<typeof vi.fn> }
}

const BASE_ARGS = {
  runtimeEnvironmentId: null,
  sourceGroupId: 'source-group',
  splitDirection: 'right' as const,
  worktreeId: 'worktree-1',
  worktreePath: WORKTREE_PATH
}

describe('resolveWorkspaceFileOpenTarget', () => {
  it('relativizes paths inside the worktree', () => {
    expect(resolveWorkspaceFileOpenTarget('/repo/src/app.ts', WORKTREE_PATH)).toMatchObject({
      filePath: '/repo/src/app.ts',
      relativePath: 'src/app.ts'
    })
  })

  it('keeps the absolute path for files outside the worktree', () => {
    expect(resolveWorkspaceFileOpenTarget('/elsewhere/notes.md', WORKTREE_PATH)).toMatchObject({
      relativePath: '/elsewhere/notes.md'
    })
  })

  it('keeps the absolute path when the worktree path is unknown', () => {
    expect(resolveWorkspaceFileOpenTarget('/repo/src/app.ts', null)).toMatchObject({
      relativePath: '/repo/src/app.ts'
    })
  })
})

describe('openWorkspaceFilePathsInSplit', () => {
  it('splits beside the drop target and opens the file in the new group', async () => {
    const deps = makeDeps()
    const groupId = await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/src/app.ts']
    })

    expect(groupId).toBe('new-group')
    expect(deps.createEmptySplitGroup).toHaveBeenCalledWith('worktree-1', 'source-group', 'right')
    expect(deps.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit',
        relativePath: 'src/app.ts',
        worktreeId: 'worktree-1'
      }),
      expect.objectContaining({ preview: false, targetGroupId: 'new-group' })
    )
  })

  it('opens every dropped file into the one new group', async () => {
    const deps = makeDeps()
    await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts', '/repo/b.ts']
    })

    expect(deps.createEmptySplitGroup).toHaveBeenCalledTimes(1)
    expect(deps.openFile).toHaveBeenCalledTimes(2)
    for (const call of deps.openFile.mock.calls) {
      expect(call[1]).toMatchObject({ targetGroupId: 'new-group' })
    }
  })

  it('focuses only the tab left on top of a multi-file drop', async () => {
    const deps = makeDeps()
    await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts', '/repo/b.ts']
    })

    expect(deps.openFile.mock.calls.map((call) => call[1].focusEditor)).toEqual([false, true])
  })

  it('checks the dropped paths concurrently, not one runtime round-trip at a time', async () => {
    let inFlight = 0
    let peakInFlight = 0
    const deps = makeDeps({
      isDirectory: vi.fn(async () => {
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return false
      })
    })
    await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']
    })

    expect(peakInFlight).toBeGreaterThan(1)
  })

  it('keeps drop order when the directory checks settle out of order', async () => {
    const delays: Record<string, number> = { '/repo/a.ts': 30, '/repo/b.ts': 1, '/repo/c.ts': 15 }
    const deps = makeDeps({
      isDirectory: vi.fn(
        (path: string) =>
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), delays[path] ?? 0))
      )
    })
    await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']
    })

    expect(deps.openFile.mock.calls.map((call) => call[0].relativePath)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts'
    ])
  })

  it('does not split when every dropped path is a directory', async () => {
    const deps = makeDeps({ isDirectory: vi.fn(async () => true) })
    const groupId = await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/src']
    })

    expect(groupId).toBeNull()
    expect(deps.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(deps.openFile).not.toHaveBeenCalled()
  })

  it('opens only the files from a mixed file/folder selection', async () => {
    const deps = makeDeps({ isDirectory: vi.fn(async (path: string) => path === '/repo/src') })
    await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/src', '/repo/a.ts']
    })

    expect(deps.openFile).toHaveBeenCalledTimes(1)
    expect(deps.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'a.ts' }),
      expect.anything()
    )
  })

  it('suppresses the active-runtime fallback only for local drops', async () => {
    const local = makeDeps()
    await openWorkspaceFilePathsInSplit(local, { ...BASE_ARGS, paths: ['/repo/a.ts'] })
    expect(local.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: undefined }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )

    const remote = makeDeps()
    await openWorkspaceFilePathsInSplit(remote, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts'],
      runtimeEnvironmentId: 'ssh-host'
    })
    expect(remote.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: 'ssh-host' }),
      expect.objectContaining({ suppressActiveRuntimeFallback: false })
    )
  })

  it('opens nothing when the split cannot be created', async () => {
    const deps = makeDeps({ createEmptySplitGroup: vi.fn(() => null) })
    const groupId = await openWorkspaceFilePathsInSplit(deps, {
      ...BASE_ARGS,
      paths: ['/repo/a.ts']
    })

    expect(groupId).toBeNull()
    expect(deps.openFile).not.toHaveBeenCalled()
  })
})
