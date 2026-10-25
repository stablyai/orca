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
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

// Observe subscription release at the store boundary: verdicts need it after waiters leave, but draining both must unsubscribe to avoid session-long rescans. No test-only production export is needed.

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
      [WORKTREE_ID]: [
        ...published.filter((tab) => tab.id !== tabId),
        makeTerminalTab({ id: tabId, worktreeId: WORKTREE_ID, title: tabId })
      ]
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
  })
  parkUntilHostMirrorHandleLands(environmentId, WORKTREE_ID, tabId, () => {})
}

/** Lands the pane's handle, which is what both releases a waiter and retires a verdict. */
function landHandle(tabId: string): void {
  useAppStore.setState({
    ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, [tabId]: [`pty-${tabId}`] }
  })
}

describe('host-mirror handle-gap store subscription lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    unsubscribeCalls = 0
    subscribeCalls = 0
    const realSubscribe = useAppStore.subscribe.bind(useAppStore)
    vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      subscribeCalls += 1
      const unsubscribe = realSubscribe(listener)
      return () => {
        unsubscribeCalls += 1
        unsubscribe()
      }
    })
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
    // A verdict outlives its waiter and still needs landed-handle observation.
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
