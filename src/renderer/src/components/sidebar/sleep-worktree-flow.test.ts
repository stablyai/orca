import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: {
    activeWorktreeId: string | null
    setActiveWorktree: ReturnType<typeof vi.fn>
    shutdownWorktreeBrowsers: ReturnType<typeof vi.fn>
    shutdownWorktreeTerminals: ReturnType<typeof vi.fn>
    suppressPtyExit: ReturnType<typeof vi.fn>
    consumeSuppressedPtyExit: ReturnType<typeof vi.fn>
    tabsByWorktree: Record<string, { id: string }[]>
    ptyIdsByTabId: Record<string, string[]>
  } = {
    activeWorktreeId: null,
    setActiveWorktree: vi.fn((worktreeId: string | null) => {
      state.activeWorktreeId = worktreeId
    }),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
    suppressPtyExit: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(),
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>
  }
  const suspendWorkspace = vi.fn().mockResolvedValue(null)
  const toastError = vi.fn()
  const markWorktreeSleepIntent = vi.fn()
  const clearWorktreeSleepIntent = vi.fn()
  return {
    clearWorktreeSleepIntent,
    markWorktreeSleepIntent,
    state,
    suspendWorkspace,
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

import { runSleepWorktree, runSleepWorktrees } from './sleep-worktree-flow'

describe('runSleepWorktree', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          suspendWorkspace: mocks.suspendWorkspace
        }
      },
      requestAnimationFrame: vi.fn()
    })
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockResolvedValue(undefined)
    mocks.state.suppressPtyExit.mockClear()
    mocks.state.consumeSuppressedPtyExit.mockClear()
    mocks.suspendWorkspace.mockClear().mockResolvedValue(null)
    mocks.markWorktreeSleepIntent.mockClear()
    mocks.clearWorktreeSleepIntent.mockClear()
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
    expect(mocks.suspendWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-1' })
    const browsersCallOrder = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    const terminalsCallOrder = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    const suspendCallOrder = mocks.suspendWorkspace.mock.invocationCallOrder[0]
    expect(browsersCallOrder).toBeLessThan(terminalsCallOrder)
    expect(terminalsCallOrder).toBeLessThan(suspendCallOrder)
  })

  it('clears activeWorktreeId before teardown when the slept worktree is active', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const browsersCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(activeClear).toBeLessThan(browsersCall)
  })

  it('marks sleep intent before clearing the active slept worktree and keeps it after teardown', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    const markCall = mocks.markWorktreeSleepIntent.mock.invocationCallOrder[0]
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    expect(markCall).toBeLessThan(activeClear)
    // Why: the marker outlives a successful sleep so mounted panes stay cold until an explicit wake.
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('preserves active row position through section-scoped sidebar row ids', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const row = {
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      getBoundingClientRect: () => ({ top: 42 })
    }
    const option = {
      dataset: { worktreeId: 'wt-1' },
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) => (selector === '[data-worktree-id]' ? [option] : [])
    })
    vi.stubGlobal('window', { requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  it('anchors sleep restoration to the natural duplicate row when no primary row is marked', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const pinnedGetBoundingClientRect = vi.fn(() => ({ top: 10 }))
    const naturalGetBoundingClientRect = vi.fn(() => ({ top: 42 }))
    const pinnedRow = {
      getBoundingClientRect: pinnedGetBoundingClientRect
    }
    const naturalRow = {
      getBoundingClientRect: naturalGetBoundingClientRect
    }
    const pinnedOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'pinned:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? pinnedRow : null,
      querySelector: () => null
    }
    const naturalOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'all:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? naturalRow : null,
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) =>
        selector === '[data-worktree-id]' ? [pinnedOption, naturalOption] : []
    })
    vi.stubGlobal('window', { requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(naturalGetBoundingClientRect).toHaveBeenCalled()
    expect(pinnedGetBoundingClientRect).not.toHaveBeenCalled()
  })

  it('leaves activeWorktreeId alone and marks a background worktree slept', async () => {
    mocks.state.activeWorktreeId = 'wt-other'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.state.suppressPtyExit).not.toHaveBeenCalled()
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('leaves a worktree the user activated mid-batch awake', async () => {
    let releaseFirst: () => void = () => {}
    mocks.state.shutdownWorktreeBrowsers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )

    const run = runSleepWorktrees(['wt-1', 'wt-2'])
    await Promise.resolve()
    // Why: the user clicked wt-2 while wt-1 was tearing down; sleeping it anyway
    // must not leave the active workspace marked with no clear pending.
    mocks.state.activeWorktreeId = 'wt-2'
    releaseFirst()
    await run

    expect(mocks.clearWorktreeSleepIntent).toHaveBeenLastCalledWith('wt-2')
  })

  it('re-asserts the marker after teardown so a late PTY bind cannot un-sleep it', async () => {
    await runSleepWorktree('wt-1')

    const marks = mocks.markWorktreeSleepIntent.mock.invocationCallOrder
    const terminalShutdown = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    expect(marks.some((order) => order > terminalShutdown)).toBe(true)
  })

  it('marks each worktree only when its own teardown starts', async () => {
    let releaseFirst: () => void = () => {}
    mocks.state.shutdownWorktreeBrowsers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )

    const run = runSleepWorktrees(['wt-1', 'wt-2'])
    await Promise.resolve()

    // Why: wt-2 is still awake while wt-1 tears down; marking it early would
    // hold its panes cold and swallow its activity.
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.markWorktreeSleepIntent).not.toHaveBeenCalledWith('wt-2')
    releaseFirst()
    await run
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-2')
  })

  it('surfaces a toast and skips terminals when browsers throws', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeBrowsers.mockRejectedValueOnce(new Error('boom'))
    mocks.state.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalled()
    expect(mocks.suspendWorkspace).not.toHaveBeenCalled()
    expect(mocks.clearWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.setActiveWorktree).toHaveBeenLastCalledWith('wt-1')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({
        description:
          'The workspace was kept open. Try again; if the problem continues, check the host connection.'
      })
    )
  })

  it('restores the active workspace when terminal convergence fails', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeTerminals.mockRejectedValueOnce(
      new Error('terminal_worktree_sleep_still_live')
    )

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null], ['wt-1']])
    expect(mocks.suspendWorkspace).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({
        description:
          'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
      })
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
    expect(mocks.suspendWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-2' })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep some workspaces',
      expect.objectContaining({
        description:
          'The workspace was kept open. Try again; if the problem continues, check the host connection.'
      })
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
    expect(mocks.suspendWorkspace).toHaveBeenNthCalledWith(1, { workspaceId: 'wt-1' })
    expect(mocks.suspendWorkspace).toHaveBeenNthCalledWith(2, { workspaceId: 'wt-2' })
  })
})
