import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

// Cover store-drain and deadline replays directly: one pane’s throw must not escape to mirror apply, sibling waiters or later subscribers; re-entry must not replay or release stale snapshots.

const ENVIRONMENT_ID = 'env-handle-gap-drain'
const WORKTREE_ID = 'repo-1::/workspace/repo'
const FIRST_TAB_ID = 'web-terminal-host-tab-1'
const SECOND_TAB_ID = 'web-terminal-host-tab-2'

const initialAppStoreState = useAppStore.getState()

function seedRows(): void {
  // Seed the PTY binding held at park time: production cannot park an unbound pane, whose verdict refuses to answer.
  useAppStore.setState({
    ptyIdsByTabId: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTerminalTab({ id: FIRST_TAB_ID, worktreeId: WORKTREE_ID, title: 'one' }),
        makeTerminalTab({ id: SECOND_TAB_ID, worktreeId: WORKTREE_ID, title: 'two' })
      ]
    },
    terminalLayoutsByTabId: {
      [FIRST_TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': `remote:${ENVIRONMENT_ID}@@term_1` }
      },
      [SECOND_TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-2' },
        activeLeafId: 'leaf-2',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-2': `remote:${ENVIRONMENT_ID}@@term_2` }
      }
    }
  })
}

/** The host publishes both panes' PTY handles on one frame: both waiters come due together. */
function publishBothHandles(): void {
  useAppStore.setState({
    ptyIdsByTabId: {
      [FIRST_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_1`],
      [SECOND_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_2`]
    }
  })
}

describe('host-mirror handle-gap drain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Replay throws are intentional; silence the warning while testing their isolation.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    seedRows()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  // Zustand notifies synchronously; an unguarded replay throw would abort mirror setState, sibling replays and later subscribers.
  it('does not let one pane’s replay throw reach the store write, its siblings, or later listeners', () => {
    const siblingReplay = vi.fn()
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(2)

    // Registered after this module's subscription, so it is notified after the drain.
    const laterListener = vi.fn()
    const unsubscribe = useAppStore.subscribe(laterListener)

    expect(() => publishBothHandles()).not.toThrow()
    unsubscribe()

    expect(siblingReplay).toHaveBeenCalledTimes(1)
    expect(laterListener).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // Both deadlines are cancelled, so neither pane can record an expiry it did not earn.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS * 2)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, FIRST_TAB_ID)).toBe(false)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, SECOND_TAB_ID)).toBe(false)
  })

  // A createTab replay re-enters the drain synchronously; one frame must release each pane at most once even if it re-parks.
  it('replays a pane once per store write even when an earlier replay re-enters the drain', () => {
    const siblingReplay = vi.fn(() => {
      // What the real replay does when the sweep still finds the pane undecided.
      parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      // Re-enter through subscribed tab/PTY slices; clearSleepingAgentSession alone would be filtered out.
      useAppStore.setState({ tabsByWorktree: { ...useAppStore.getState().tabsByWorktree } })
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)

    publishBothHandles()

    expect(siblingReplay).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  // Orphan adoption can mutate a still-parked waiter’s workspace in place during another replay; identity checks alone cannot detect its obsolete retraction verdict.
  it('does not release on retraction evidence a mid-drain adoption has already made stale', () => {
    const adoptedReplay = vi.fn()
    const ADOPTING_WORKTREE_ID = 'repo-1::/workspace/adopted'
    useAppStore.setState({
      tabsByWorktree: {
        [ADOPTING_WORKTREE_ID]: [
          makeTerminalTab({ id: FIRST_TAB_ID, worktreeId: ADOPTING_WORKTREE_ID, title: 'one' }),
          makeTerminalTab({ id: SECOND_TAB_ID, worktreeId: ADOPTING_WORKTREE_ID, title: 'two' })
        ]
      }
    })
    // Map order makes adoption invalidate the next waiter’s snapshot before release; reversing order must fail the case.
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, ADOPTING_WORKTREE_ID, FIRST_TAB_ID, () => {
      // The adopting workspace re-parks its newly owned pane without any launch/store write.
      parkUntilHostMirrorHandleLands(
        ENVIRONMENT_ID,
        ADOPTING_WORKTREE_ID,
        SECOND_TAB_ID,
        adoptedReplay
      )
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, adoptedReplay)

    // The absent second tab reads as retracted; adoption above invalidates that snapshot before release.
    useAppStore.setState({
      ptyIdsByTabId: { [FIRST_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_1`] }
    })

    expect(adoptedReplay).not.toHaveBeenCalled()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })

  // Deadline replay throws must stay isolated but retain expiry evidence, or every failure would get a fresh wait forever.
  it('records the expiry of a pane whose replay throws and still frees the pane', () => {
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })

    expect(() => vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)).not.toThrow()

    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, FIRST_TAB_ID)).toBe(true)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
