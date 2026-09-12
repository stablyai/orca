import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  clearHostMirrorHandleGapVerdictsForEnvironment,
  countHostMirrorHandleGapVerdictsForTests,
  countParkedHostMirrorHandleGapPanesForTests,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

// The retention suite that the reconciled verdict loop replaced carried one assertion the split
// suites did not: the store subscription is held for exactly as long as something needs it.
//
// Measured rather than assumed, because half of it turned out to be covered already:
//   - RETAIN direction (drop the verdict term from `stopStoreSubscriptionIfIdle`, so a verdict
//     with no waiter behind it loses the subscription its drain needs): already caught, by
//     host-mirror-handle-gap-landed-handle.test.ts. Two failures there without this file.
//   - RELEASE direction (never release the subscription at all): caught by NOTHING. That mutation
//     passes all 272 tests across the 33 other handle-gap and session-tabs suites. A leaked
//     subscription rescans every parked pane on every store write for the life of the session and
//     no test notices.
//
// So this file exists for the release direction; the retain cases are here because the two belong
// in one place, not because they were missing. `stopStoreSubscriptionIfIdle` counts VERDICTS as
// well as waiters -- the landed-handle drain observes a transition no waiter is parked for -- and
// that is exactly the term the reconcile moved, so both directions are worth holding still.
//
// Asserted through a spy rather than a new test-only export: whether the module is subscribed is
// already observable at the store boundary, and the production surface should not grow to say so.

const ENVIRONMENT_ID = 'env-subscription'
const OTHER_ENVIRONMENT_ID = 'env-other'
const WORKTREE_ID = 'repo-1::/workspace/repo'

const initialAppStoreState = useAppStore.getState()

let unsubscribeCalls: number
let subscribeCalls: number

function publishPaneAndPark(environmentId: string, tabId: string): void {
  const state = useAppStore.getState()
  const published = state.tabsByWorktree[WORKTREE_ID] ?? []
  useAppStore.setState({
    ptyIdsByTabId: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [...published.filter((tab) => tab.id !== tabId), { id: tabId, title: tabId }]
    },
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      [tabId]: {
        root: { type: 'leaf', leafId: `leaf-${tabId}` },
        activeLeafId: `leaf-${tabId}`,
        expandedLeafId: null,
        ptyIdsByLeafId: { [`leaf-${tabId}`]: `remote:${environmentId}@@term_${tabId}` }
      }
    }
  } as never)
  parkUntilHostMirrorHandleLands(environmentId, WORKTREE_ID, tabId, () => {})
}

/** Lands the pane's handle, which is what both releases a waiter and retires a verdict. */
function landHandle(tabId: string): void {
  useAppStore.setState({
    ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, [tabId]: [`pty-${tabId}`] }
  } as never)
}

describe('host-mirror handle-gap store subscription lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    unsubscribeCalls = 0
    subscribeCalls = 0
    const realSubscribe = useAppStore.subscribe.bind(useAppStore)
    vi.spyOn(useAppStore, 'subscribe').mockImplementation(((listener: never) => {
      subscribeCalls += 1
      const unsubscribe = realSubscribe(listener)
      return () => {
        unsubscribeCalls += 1
        unsubscribe()
      }
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  it('holds exactly one subscription across several parked panes', () => {
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-a')
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-b')
    publishPaneAndPark(OTHER_ENVIRONMENT_ID, 'tab-c')

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(3)
    expect(subscribeCalls).toBe(1)
    expect(unsubscribeCalls).toBe(0)
  })

  it('releases the subscription once the last waiter leaves and no verdict remains', () => {
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-a')
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-b')

    landHandle('tab-a')
    expect(unsubscribeCalls).toBe(0)

    landHandle('tab-b')
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
    expect(unsubscribeCalls).toBe(1)
  })

  it('keeps the subscription for a verdict with no waiter parked behind it', () => {
    // The case the reconcile introduced: the waiter is gone, but the landed-handle drain still has
    // a verdict to watch. Counting only waiters here would drop the subscription that drain needs.
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-a')
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(1)
    expect(unsubscribeCalls).toBe(0)
  })

  it('releases the subscription when the last verdict is cleared by teardown', () => {
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-a')
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(unsubscribeCalls).toBe(0)

    clearHostMirrorHandleGapVerdictsForEnvironment(ENVIRONMENT_ID)

    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
    expect(unsubscribeCalls).toBe(1)
  })

  it('re-subscribes rather than reusing a dropped subscription', () => {
    publishPaneAndPark(ENVIRONMENT_ID, 'tab-a')
    landHandle('tab-a')
    expect(unsubscribeCalls).toBe(1)

    publishPaneAndPark(ENVIRONMENT_ID, 'tab-d')

    expect(subscribeCalls).toBe(2)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })
})
