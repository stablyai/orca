/** A server that restarted publishes its restored agents without their worktree, and restored panes
 * wait for a stream handle. When that server closes such a tab, a paired desktop must drop the tab
 * and its agent row like any other retraction, not keep a greyed retained row for a pane that is gone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import {
  buildRetainedAgentsSyncSnapshot,
  collectRetainedAgentsOnDisappear
} from '../components/dashboard/useRetainedAgents'
import { buildWorktreeAgentRows } from '../components/sidebar/workspace-card/activity/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from '../components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../components/sidebar/workspace-card/activity/worktree-card-status-inputs'

// Mirror imports app store singleton; redirect it to this createTestStore harness.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const T0 = 1_700_000_000_000
const KEEP_TAB = 'host-tab-live'
const CLOSED_TAB = 'host-tab-finished-worker'
const LEAF: Record<string, string> = {
  [KEEP_TAB]: '11111111-1111-4111-8111-111111111111',
  [CLOSED_TAB]: '22222222-2222-4222-8222-222222222222'
}
const paneKeyOf = (hostTabId: string) =>
  makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF[hostTabId]!)
const KEEP_PANE_KEY = paneKeyOf(KEEP_TAB)
const CLOSED_PANE_KEY = paneKeyOf(CLOSED_TAB)

type TestStore = ReturnType<typeof createTestStore>
type RetainedSyncAgents = ReturnType<typeof buildRetainedAgentsSyncSnapshot>['currentAgents']

/** A restarted server's frame: restored panes wait for a handle and their agents name no worktree. */
function restoredHostSnapshot(
  snapshotVersion: number,
  hostTabIds: readonly string[]
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'headless-hydrated:restarted',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: hostTabIds[0] ? `${hostTabIds[0]}::${LEAF[hostTabIds[0]]}` : null,
    activeTabType: hostTabIds.length > 0 ? 'terminal' : null,
    tabs: hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF[hostTabId]}`,
      title: hostTabId,
      parentTabId: hostTabId,
      leafId: LEAF[hostTabId]!,
      isActive: index === 0,
      ptyId: `${WT}@@pty-${index + 1}`,
      status: 'pending-handle' as const,
      terminal: null,
      agentStatus: {
        state: 'done' as const,
        prompt: `work in ${hostTabId}`,
        updatedAt: T0 - 60_000,
        stateStartedAt: T0 - 120_000,
        agentType: 'codex',
        paneKey: makePaneKey(hostTabId, LEAF[hostTabId]!),
        tabId: hostTabId,
        restoredUnconfirmed: true,
        stateHistory: []
      }
    }))
  }
}

function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
) {
  vi.setSystemTime(now)
  const state = store.getState()
  const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now)
  expect(patch, 'host snapshot must pass the freshness gate').not.toBe(state)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate returned a store patch for this state (checked above); the test applies it as the store would.
  store.setState(patch as Partial<AppState>)
}

/** useRetainedAgentsSync's effect body, minus React. */
function replayRetainedAgentsSync(
  store: TestStore,
  previousAgents: RetainedSyncAgents,
  now: number
): RetainedSyncAgents {
  const state = store.getState()
  const { currentAgents, existingWorktreeIds, tabIndex } = buildRetainedAgentsSyncSnapshot({
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    tabsByWorktree: state.tabsByWorktree,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    now
  })
  const { toRetain, consumedSuppressedPaneKeys } = collectRetainedAgentsOnDisappear({
    previousAgents,
    currentAgents,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys,
    recentlyClosedAgentStatusTabIds: state.recentlyClosedAgentStatusTabIds,
    recentlyRetiredAgentStatusPaneKeys: state.recentlyRetiredAgentStatusPaneKeys,
    tabIndex
  })
  store.getState().retainAgents(toRetain)
  store.getState().pruneRetainedAgents(existingWorktreeIds)
  if (consumedSuppressedPaneKeys.length > 0) {
    store.getState().clearRetentionSuppressedPaneKeys(consumedSuppressedPaneKeys)
  }
  return currentAgents
}

/** The sidebar card's agent rows and the tab strip, as useWorktreeAgentRows builds them. */
function observeDesktop(store: TestStore, now: number) {
  const state = store.getState()
  const tabs = state.tabsByWorktree[WT] ?? []
  const rows = buildWorktreeAgentRows({
    tabs,
    entries: selectLiveAgentStatusEntriesForWorktree(state, WT),
    retained: selectRetainedAgentEntriesForWorktree(state, WT),
    runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, WT),
    ptyIdsByTabId: selectLivePtyIdsForWorktree(state, WT),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [tab.id, state.terminalLayoutsByTabId[tab.id]])
    ),
    now
  })
  return {
    tabIds: tabs.map((tab) => tab.id),
    rowPaneKeys: rows.filter((row) => row.rowSource !== 'subagent').map((row) => row.paneKey),
    retainedPaneKeys: Object.keys(state.retainedAgentsByPaneKey)
  }
}

function seedPairedDesktop(): TestStore {
  const store = createTestStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial seed; the session-tab sync reads only these fields.
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  } as Partial<AppState>)
  return store
}

describe('a paired desktop following a restarted server', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops restored terminals the server closes, with their agent rows', () => {
    const store = seedPairedDesktop()
    let previousAgents: RetainedSyncAgents = new Map()
    applyHostSnapshot(store, restoredHostSnapshot(1, [KEEP_TAB, CLOSED_TAB]), T0)
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 500)
    expect(observeDesktop(store, T0 + 500).rowPaneKeys).toContain(CLOSED_PANE_KEY)

    applyHostSnapshot(store, restoredHostSnapshot(2, [KEEP_TAB]), T0 + 2_000)
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 2_500)
    expect(observeDesktop(store, T0 + 3_000)).toEqual({
      tabIds: [toWebTerminalSurfaceTabId(KEEP_TAB)],
      rowPaneKeys: [KEEP_PANE_KEY],
      retainedPaneKeys: []
    })

    // The last tab's retraction publishes an empty worktree.
    applyHostSnapshot(store, restoredHostSnapshot(3, []), T0 + 4_000)
    replayRetainedAgentsSync(store, previousAgents, T0 + 4_500)
    expect(observeDesktop(store, T0 + 5_000)).toEqual({
      tabIds: [],
      rowPaneKeys: [],
      retainedPaneKeys: []
    })
  })
})
