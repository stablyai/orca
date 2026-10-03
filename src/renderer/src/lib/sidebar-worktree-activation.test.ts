import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  clearPendingRevealSidebarRow: vi.fn(),
  clearPendingRevealWorktreeId: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      clearPendingRevealSidebarRow: mocks.clearPendingRevealSidebarRow,
      clearPendingRevealWorktreeId: mocks.clearPendingRevealWorktreeId
    })
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.clearPendingRevealSidebarRow.mockClear()
    mocks.clearPendingRevealWorktreeId.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates a clicked worktree without sidebar reveal', async () => {
    await activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('cancels pending sidebar reveals before activating the selected workspace', async () => {
    await activateWorktreeFromSidebar('wt-pinned')

    expect(mocks.clearPendingRevealWorktreeId).toHaveBeenCalledOnce()
    expect(mocks.clearPendingRevealSidebarRow).toHaveBeenCalledOnce()
    expect(mocks.clearPendingRevealWorktreeId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]
    )
    expect(mocks.clearPendingRevealSidebarRow.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]
    )
  })

  it('does not defer non-VM slept worktree selection behind terminal wake work', async () => {
    await activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('switches immediately while an ephemeral runtime wake is pending', async () => {
    let resolveResume: ((value: null) => void) | undefined
    const resumeWorkspace = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveResume = resolve
        })
    )
    vi.stubGlobal('window', {
      api: { ephemeralVm: { resumeWorkspace } }
    })

    const activation = activateWorktreeFromSidebar('wt-vm')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-vm', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-vm' })

    resolveResume?.(null)
    await activation
  })

  it('routes folder workspace activation through the guarded folder path', async () => {
    await activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
