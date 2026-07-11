import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  resumeWorkspace: vi.fn()
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
    mocks.resumeWorkspace.mockReset().mockResolvedValue(null)
    vi.stubGlobal('window', { api: { ephemeralVm: { resumeWorkspace: mocks.resumeWorkspace } } })
  })

  it('activates a clicked worktree without sidebar reveal', async () => {
    await activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('does not defer non-VM slept worktree selection behind terminal wake work', async () => {
    await activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept', {
      revealInSidebar: false
    })
  })

  it('does not let a late VM resume override a newer workspace click', async () => {
    let releaseResume = () => {}
    mocks.resumeWorkspace
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseResume = () => resolve(null)
          })
      )
      .mockResolvedValueOnce(null)

    const staleActivation = activateWorktreeFromSidebar('wt-vm')
    await activateWorktreeFromSidebar('wt-local')
    releaseResume()
    await staleActivation

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-local', {
      revealInSidebar: false
    })
  })

  it('routes folder workspace activation through the guarded folder path', async () => {
    await activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
