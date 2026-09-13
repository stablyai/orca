import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateNotificationRuntimeTarget } from './notification-runtime-navigation'

const runtimeMocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  activateWorktree: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: runtimeMocks.activateTab,
  activateWebRuntimeSessionWorktree: runtimeMocks.activateWorktree
}))

describe('activateNotificationRuntimeTarget', () => {
  beforeEach(() => vi.clearAllMocks())

  it('activates the exact runtime leaf when it is still known', async () => {
    runtimeMocks.activateTab.mockResolvedValueOnce(true)

    await expect(
      activateNotificationRuntimeTarget({
        executionHostId: 'runtime:env-1',
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    ).resolves.toBe(true)

    expect(runtimeMocks.activateTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      environmentId: 'env-1'
    })
    expect(runtimeMocks.activateWorktree).not.toHaveBeenCalled()
  })

  it('activates only the runtime worktree when no target tab remains', async () => {
    runtimeMocks.activateWorktree.mockResolvedValueOnce(true)

    await expect(
      activateNotificationRuntimeTarget({
        executionHostId: 'runtime:env-1',
        worktreeId: 'wt-1'
      })
    ).resolves.toBe(true)

    expect(runtimeMocks.activateWorktree).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'env-1'
    })
    expect(runtimeMocks.activateTab).not.toHaveBeenCalled()
  })

  it('reports a stale runtime tab without falling through to worktree activation', async () => {
    runtimeMocks.activateTab.mockResolvedValueOnce(false)

    await expect(
      activateNotificationRuntimeTarget({
        executionHostId: 'runtime:env-1',
        worktreeId: 'wt-1',
        tabId: 'tab-stale',
        leafId: 'leaf-stale'
      })
    ).resolves.toBe(false)
    expect(runtimeMocks.activateWorktree).not.toHaveBeenCalled()
  })

  it('keeps runtime folder fallback local instead of sending an invalid worktree selector', async () => {
    await expect(
      activateNotificationRuntimeTarget({
        executionHostId: 'runtime:env-1',
        worktreeId: 'folder:folder-1'
      })
    ).resolves.toBe(true)

    expect(runtimeMocks.activateTab).not.toHaveBeenCalled()
    expect(runtimeMocks.activateWorktree).not.toHaveBeenCalled()
  })
})
