import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import { clearWebSessionTabsTrackingForEnvironment } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  clearHostMirrorHandleGapVerdictsForEnvironment,
  countHostMirrorHandleGapVerdictsForTests,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

// Teardown must evict removed environments that will never record another verdict; recording-time pruning cannot reach them.

const ENVIRONMENT_ID = 'env-torn-down'
const OTHER_ENVIRONMENT_ID = 'env-survivor'
const WORKTREE_ID = 'repo-1::/workspace/repo'

const initialAppStoreState = useAppStore.getState()

function parkAndExpire(environmentId: string, tabId: string): void {
  // Accumulate live rows so tab-death pruning cannot hide the teardown-only retention case.
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
    // Bind each pane to its own environment or fixtures record empty identity and cannot answer verdict queries.
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
  vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
}

describe('host-mirror handle-gap verdicts across environment teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  it('drops the torn-down environment’s verdicts and keeps every other environment’s', () => {
    parkAndExpire(ENVIRONMENT_ID, 'web-terminal-host-tab-1')
    parkAndExpire(ENVIRONMENT_ID, 'web-terminal-host-tab-2')
    parkAndExpire(OTHER_ENVIRONMENT_ID, 'web-terminal-host-tab-3')
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(3)

    clearHostMirrorHandleGapVerdictsForEnvironment(ENVIRONMENT_ID)

    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(1)
    expect(hasHostMirrorHandleWaitExpired(OTHER_ENVIRONMENT_ID, 'web-terminal-host-tab-3')).toBe(
      true
    )
  })

  // As with clearHostSessionMirrorHydration, re-pair replaces evidence without canceling recovery; bounded waiters must survive and replay.
  it('leaves a parked waiter alone, cancelling only the verdicts', () => {
    const replay = vi.fn()
    useAppStore.setState({
      ptyIdsByTabId: {},
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab({ id: 'web-terminal-host-tab-9', worktreeId: WORKTREE_ID, title: 'nine' })
        ]
      }
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, 'web-terminal-host-tab-9', replay)

    clearHostMirrorHandleGapVerdictsForEnvironment(ENVIRONMENT_ID)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(replay).toHaveBeenCalledTimes(1)
  })

  // Wire cleanup to session-tabs environment teardown, the only caller guaranteed on permanent removal.
  it('drains through the session-tabs tracking teardown for the environment', () => {
    parkAndExpire(ENVIRONMENT_ID, 'web-terminal-host-tab-1')
    parkAndExpire(OTHER_ENVIRONMENT_ID, 'web-terminal-host-tab-3')
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(2)

    clearWebSessionTabsTrackingForEnvironment(ENVIRONMENT_ID)

    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(1)
    expect(hasHostMirrorHandleWaitExpired(OTHER_ENVIRONMENT_ID, 'web-terminal-host-tab-3')).toBe(
      true
    )
  })

  // Environment removal advances generation; leaked verdicts must remain unreachable even if the ID returns.
  it('cannot match again after the environment returns on a new generation', () => {
    parkAndExpire(ENVIRONMENT_ID, 'web-terminal-host-tab-1')
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, 'web-terminal-host-tab-1')).toBe(true)

    setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 1)

    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, 'web-terminal-host-tab-1')).toBe(false)
  })
})
