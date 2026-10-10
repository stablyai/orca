// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireBrowserAutomationBootstrapLease } from './browser-automation-bootstrap-lease'

const mocks = vi.hoisted(() => ({
  acquireVisibility: vi.fn(),
  releaseVisibility: vi.fn(),
  requestBackgroundMount: vi.fn()
}))

vi.mock('@/components/browser-pane/host-guest/browser-automation-visibility', () => ({
  acquireBrowserAutomationVisibility: mocks.acquireVisibility,
  releaseBrowserAutomationVisibility: mocks.releaseVisibility
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.requestBackgroundMount
}))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: 'wt-active',
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      activeBrowserTabIdByWorktree: {}
    })
  }
}))

describe('browser automation bootstrap lease ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.acquireVisibility
      .mockReturnValueOnce('lease-1')
      .mockReturnValueOnce('lease-2')
      .mockReturnValueOnce('lease-3')
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('replaces a same-page lease and expires different page leases independently after 10s', () => {
    acquireBrowserAutomationBootstrapLease('wt-1', 'page-1')
    acquireBrowserAutomationBootstrapLease('wt-1', 'page-1')
    acquireBrowserAutomationBootstrapLease('wt-2', 'page-2')

    expect(mocks.releaseVisibility).toHaveBeenCalledTimes(1)
    expect(mocks.releaseVisibility).toHaveBeenLastCalledWith('lease-1')
    expect(mocks.requestBackgroundMount.mock.calls).toEqual([
      [{ worktreeId: 'wt-1' }],
      [{ worktreeId: 'wt-1' }],
      [{ worktreeId: 'wt-2' }]
    ])

    vi.advanceTimersByTime(9_999)
    expect(mocks.releaseVisibility).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(mocks.releaseVisibility.mock.calls).toEqual([['lease-1'], ['lease-2'], ['lease-3']])
  })
})
