import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: null as string | null,
    setActiveWorktree: vi.fn(),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined)
  }
  const toastError = vi.fn()
  return { state, toastError }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { runSleepWorktree, runSleepWorktrees } from './sleep-worktree-flow'

describe('runSleepWorktree', () => {
  beforeEach(() => {
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockResolvedValue(undefined)
    mocks.toastError.mockClear()
    mocks.state.activeWorktreeId = null
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
    const browsersCallOrder = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    const terminalsCallOrder = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    expect(browsersCallOrder).toBeLessThan(terminalsCallOrder)
  })

  it('clears activeWorktreeId before teardown when the slept worktree is active', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const browsersCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(activeClear).toBeLessThan(browsersCall)
  })

  it('leaves activeWorktreeId alone when sleeping a background worktree', async () => {
    mocks.state.activeWorktreeId = 'wt-other'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('surfaces a toast and skips terminals when browsers throws', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeBrowsers.mockRejectedValueOnce(new Error('boom'))

    await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalled()
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
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-2')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-2', {
      keepIdentifiers: true
    })
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
