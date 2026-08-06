import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  resumeWorkspace: vi.fn(),
  listRuntimeEnvironments: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setRuntimeEnvironments: mocks.setRuntimeEnvironments,
      refreshRuntimeEnvironmentStatus: mocks.refreshRuntimeEnvironmentStatus
    })
  }
}))

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'
import { beginNavigationIntent } from './navigation-intent'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.toastError.mockClear()
    mocks.resumeWorkspace.mockReset().mockResolvedValue(null)
    mocks.listRuntimeEnvironments.mockReset().mockResolvedValue([])
    mocks.setRuntimeEnvironments.mockClear()
    mocks.refreshRuntimeEnvironmentStatus.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: { resumeWorkspace: mocks.resumeWorkspace },
        runtimeEnvironments: { list: mocks.listRuntimeEnvironments }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates a clicked worktree without sidebar reveal', async () => {
    await activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-live',
      expect.objectContaining({ revealInSidebar: false, navigationIntent: expect.any(Number) })
    )
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('does not defer non-VM slept worktree selection behind terminal wake work', async () => {
    await activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-slept',
      expect.objectContaining({ revealInSidebar: false, navigationIntent: expect.any(Number) })
    )
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
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-local',
      expect.objectContaining({ revealInSidebar: false, navigationIntent: expect.any(Number) })
    )
  })

  it('does not let a late VM resume override another activation path', async () => {
    let releaseResume = () => {}
    mocks.resumeWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResume = () => resolve(null)
        })
    )

    const staleActivation = activateWorktreeFromSidebar('wt-vm')
    beginNavigationIntent()
    releaseResume()
    await staleActivation

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not apply a runtime refresh after another activation path takes over', async () => {
    let releaseList = (_runtimeEnvironments: unknown[]) => {}
    mocks.resumeWorkspace.mockResolvedValueOnce({ runtimeEnvironmentId: 'runtime-vm' })
    mocks.listRuntimeEnvironments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseList = resolve
        })
    )

    const staleActivation = activateWorktreeFromSidebar('wt-vm')
    await vi.waitFor(() => expect(mocks.listRuntimeEnvironments).toHaveBeenCalledTimes(1))
    beginNavigationIntent()
    releaseList([])
    await staleActivation

    expect(mocks.setRuntimeEnvironments).not.toHaveBeenCalled()
    expect(mocks.refreshRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('gates an in-flight runtime status write after newer navigation', async () => {
    let releaseRefresh = () => {}
    let shouldApplyRefresh: (() => boolean) | undefined
    mocks.resumeWorkspace.mockResolvedValueOnce({ runtimeEnvironmentId: 'runtime-vm' })
    mocks.refreshRuntimeEnvironmentStatus.mockImplementationOnce(
      (_runtimeEnvironmentId: string, _timeoutMs: number | undefined, shouldApply: () => boolean) =>
        new Promise<void>((resolve) => {
          shouldApplyRefresh = shouldApply
          releaseRefresh = resolve
        })
    )

    const staleActivation = activateWorktreeFromSidebar('wt-vm')
    await vi.waitFor(() => expect(shouldApplyRefresh).toEqual(expect.any(Function)))
    beginNavigationIntent()

    expect(shouldApplyRefresh?.()).toBe(false)
    releaseRefresh()
    await staleActivation
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not toast a wake failure once a newer workspace click has taken over', async () => {
    let rejectResume = (_error: Error) => {}
    mocks.resumeWorkspace
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectResume = (error: Error) => reject(error)
          })
      )
      .mockResolvedValueOnce(null)

    const staleActivation = activateWorktreeFromSidebar('wt-vm')
    await activateWorktreeFromSidebar('wt-local')
    rejectResume(new Error('vm wake failed'))
    await staleActivation

    // Why: the stale wake failure belongs to a superseded click; surfacing it
    // would blame the workspace the user has already navigated away from.
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-local',
      expect.objectContaining({ revealInSidebar: false, navigationIntent: expect.any(Number) })
    )
  })

  it('toasts a wake failure for the current workspace click', async () => {
    mocks.resumeWorkspace.mockRejectedValueOnce(new Error('vm wake failed'))

    await activateWorktreeFromSidebar('wt-vm')

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('routes folder workspace activation through the guarded folder path', async () => {
    await activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({ navigationIntent: expect.any(Number) })
    )
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
