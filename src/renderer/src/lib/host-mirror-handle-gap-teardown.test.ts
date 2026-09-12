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

// The orphan class no recording-driven prune can reach. Both existing rules — stale generation and
// tab death — run only when a verdict is RECORDED, so an environment that is removed and never
// expires another pane keeps its rows for the life of the session.

const ENVIRONMENT_ID = 'env-torn-down'
const OTHER_ENVIRONMENT_ID = 'env-survivor'
const WORKTREE_ID = 'repo-1::/workspace/repo'

const initialAppStoreState = useAppStore.getState()

function parkAndExpire(environmentId: string, tabId: string): void {
  // Rows ACCUMULATE. Replacing them would unpublish the panes parked earlier, and the tab-death
  // rule would then legitimately sweep their verdicts before teardown was ever reached — this
  // suite is about a class no recording-driven prune can reach, so every pane here stays live.
  const state = useAppStore.getState()
  const published = state.tabsByWorktree[WORKTREE_ID] ?? []
  useAppStore.setState({
    ptyIdsByTabId: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [...published.filter((tab) => tab.id !== tabId), { id: tabId, title: tabId }]
    },
    // A verdict names its PANE by the environment-minted PTY held at park time, so a fixture with
    // no layout binding records '' and the verdict refuses to answer. Bind per environment: one
    // shared environment id would filter to '' for every other environment's pane.
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

  // Matches `clearHostSessionMirrorHydration`: a re-pair replaces the connection's evidence, it
  // does not cancel the recovery this client still owes the pane. Clearing the waiter here would
  // silently drop a parked resume sweep that nothing else will replay.
  it('leaves a parked waiter alone, cancelling only the verdicts', () => {
    const replay = vi.fn()
    useAppStore.setState({
      ptyIdsByTabId: {},
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'web-terminal-host-tab-9', title: 'nine' }] }
    } as never)
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, 'web-terminal-host-tab-9', replay)

    clearHostMirrorHandleGapVerdictsForEnvironment(ENVIRONMENT_ID)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(replay).toHaveBeenCalledTimes(1)
  })

  // The live wiring: session-tabs tracking teardown is the only caller that fires for an
  // environment that is going away, so the hook has to hang off it or the rows never drain.
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

  // Why the stranded row was inert rather than dangerous, pinned so nobody "optimises" the
  // generation advance away: removing an environment advances its connection generation, so a
  // verdict left behind can never match again even if the id returns.
  it('cannot match again after the environment returns on a new generation', () => {
    parkAndExpire(ENVIRONMENT_ID, 'web-terminal-host-tab-1')
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, 'web-terminal-host-tab-1')).toBe(true)

    setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 1)

    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, 'web-terminal-host-tab-1')).toBe(false)
  })
})
