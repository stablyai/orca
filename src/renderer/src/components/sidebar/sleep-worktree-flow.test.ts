import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: null as string | null,
    markWorktreeSlept: vi.fn(),
    setActiveWorktree: vi.fn(),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
    suppressPtyExit: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(),
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>
  }
  const toastError = vi.fn()
  const markWorktreeSleepIntent = vi.fn()
  const clearWorktreeSleepIntent = vi.fn()
  const cancelPendingSidebarWorktreeActivation = vi.fn()
  return {
    cancelPendingSidebarWorktreeActivation,
    clearWorktreeSleepIntent,
    markWorktreeSleepIntent,
    state,
    toastError
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  clearWorktreeSleepIntent: mocks.clearWorktreeSleepIntent,
  markWorktreeSleepIntent: mocks.markWorktreeSleepIntent
}))
vi.mock('@/lib/sidebar-worktree-activation', () => ({
  cancelPendingSidebarWorktreeActivation: mocks.cancelPendingSidebarWorktreeActivation
}))

import { runSleepWorktree, runSleepWorktrees } from './sleep-worktree-flow'

describe('runSleepWorktree', () => {
  beforeEach(() => {
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.markWorktreeSlept.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockResolvedValue(undefined)
    mocks.state.suppressPtyExit.mockClear()
    mocks.state.consumeSuppressedPtyExit.mockClear()
    mocks.markWorktreeSleepIntent.mockClear()
    mocks.clearWorktreeSleepIntent.mockClear()
    mocks.cancelPendingSidebarWorktreeActivation.mockClear()
    mocks.toastError.mockClear()
    mocks.state.activeWorktreeId = null
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
  })

  it('tears down browsers before terminals on the sleep path', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    // Why: browsers must run first so destroyPersistentWebview can unregister
    // the Chromium guests while browserTabsByWorktree/browserPagesByWorkspace
    // are still populated. If terminals ran first and kept its old
    // browserTabsByWorktree delete, browsers would no-op and leak webviews.
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.state.markWorktreeSlept).toHaveBeenCalledWith('wt-1')
    const browsersCallOrder = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    const terminalsCallOrder = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    expect(browsersCallOrder).toBeLessThan(terminalsCallOrder)
  })

  it('cancels a queued sidebar wake before sleeping worktrees', async () => {
    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.cancelPendingSidebarWorktreeActivation).toHaveBeenCalledTimes(1)
    const cancelCall = mocks.cancelPendingSidebarWorktreeActivation.mock.invocationCallOrder[0]
    const browserCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(cancelCall).toBeLessThan(browserCall)
  })

  it('clears activeWorktreeId before teardown when the slept worktree is active', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const browsersCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(activeClear).toBeLessThan(browsersCall)
  })

  it('marks active sleep intent before clearing the active slept worktree', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.clearWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    const markCall = mocks.markWorktreeSleepIntent.mock.invocationCallOrder[0]
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const terminalShutdown = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    const clearCall = mocks.clearWorktreeSleepIntent.mock.invocationCallOrder[0]
    expect(markCall).toBeLessThan(activeClear)
    expect(terminalShutdown).toBeLessThan(clearCall)
  })

  it('leaves activeWorktreeId alone when sleeping a background worktree', async () => {
    mocks.state.activeWorktreeId = 'wt-other'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.state.suppressPtyExit).not.toHaveBeenCalled()
    expect(mocks.markWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('surfaces a toast and skips terminals when browsers throws', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeBrowsers.mockRejectedValueOnce(new Error('boom'))
    mocks.state.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalled()
    expect(mocks.state.markWorktreeSlept).not.toHaveBeenCalled()
    expect(mocks.clearWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({ description: 'boom' })
    )
  })

  it('continues sleeping later worktrees when one selected worktree fails', async () => {
    mocks.state.shutdownWorktreeBrowsers.mockImplementation((worktreeId: string) => {
      if (worktreeId === 'wt-1') {
        return Promise.reject(new Error('first failed'))
      }
      return Promise.resolve()
    })

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalledWith('wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.state.markWorktreeSlept).not.toHaveBeenCalledWith('wt-1')
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-2')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-2', {
      keepIdentifiers: true
    })
    expect(mocks.state.markWorktreeSlept).toHaveBeenCalledWith('wt-2')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep some workspaces',
      expect.objectContaining({ description: 'first failed' })
    )
  })

  it('sleeps multiple worktrees and clears active only once when included', async () => {
    mocks.state.activeWorktreeId = 'wt-2'

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenNthCalledWith(1, 'wt-1')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenNthCalledWith(1, 'wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenNthCalledWith(2, 'wt-2')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenNthCalledWith(2, 'wt-2', {
      keepIdentifiers: true
    })
  })
})
