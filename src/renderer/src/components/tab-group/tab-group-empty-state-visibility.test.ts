import { describe, expect, it, vi, beforeEach } from 'vitest'

const { getLatestEpochMock } = vi.hoisted(() => ({ getLatestEpochMock: vi.fn() }))

vi.mock('../../runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: getLatestEpochMock
}))

import {
  isAwaitingFirstHostTabs,
  shouldShowTabGroupEmptyState
} from './tab-group-empty-state-visibility'

const ready = { workspaceSessionReady: true, awaitingFirstHostTabs: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('shouldShowTabGroupEmptyState', () => {
  it('shows as soon as a group reaches zero tabs', () => {
    expect(shouldShowTabGroupEmptyState({ ...ready, tabCount: 0 })).toBe(true)
  })

  it('stays hidden while a group still has tabs', () => {
    expect(shouldShowTabGroupEmptyState({ ...ready, tabCount: 1 })).toBe(false)
  })

  it('stays hidden while the host mirror owes us its first snapshot', () => {
    expect(
      shouldShowTabGroupEmptyState({ ...ready, tabCount: 0, awaitingFirstHostTabs: true })
    ).toBe(false)
  })

  it('stays hidden until the workspace session has hydrated', () => {
    expect(
      shouldShowTabGroupEmptyState({ ...ready, workspaceSessionReady: false, tabCount: 0 })
    ).toBe(false)
  })

  // Why: the predicate takes no mount-local state, so a reparent or renderer reload
  // cannot strand a resting workspace with a blank pane and no "New terminal" action.
  it('depends only on its arguments, so a remount cannot change the answer', () => {
    const args = { ...ready, tabCount: 0 }
    expect(shouldShowTabGroupEmptyState(args)).toBe(true)
    expect(shouldShowTabGroupEmptyState(args)).toBe(true)
  })
})

describe('isAwaitingFirstHostTabs', () => {
  it('never waits for a local worktree', () => {
    expect(isAwaitingFirstHostTabs(null, 'wt-1')).toBe(false)
    expect(getLatestEpochMock).not.toHaveBeenCalled()
  })

  it('waits while a runtime-owned worktree has published no snapshot', () => {
    getLatestEpochMock.mockReturnValue(null)
    expect(isAwaitingFirstHostTabs('env-1', 'wt-1')).toBe(true)
  })

  // Why: a zero-tab host snapshot still publishes an epoch — the remote resting state
  // must read as empty, not pending, or it would render nothing at all.
  it('stops waiting once the host publishes, even reporting zero tabs', () => {
    getLatestEpochMock.mockReturnValue('epoch-1')
    expect(isAwaitingFirstHostTabs('env-1', 'wt-1')).toBe(false)
  })
})
