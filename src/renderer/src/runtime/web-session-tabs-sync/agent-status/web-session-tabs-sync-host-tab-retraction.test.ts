/** Host tab retraction sweeps renderer status and retires tab authority (STA-4593). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../../shared/runtime-session-contracts'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { AppState } from '../../../store/types'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../../../components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshots
} from '../snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import { buildWorktreeAgentRows } from '../../../components/sidebar/workspace-card/activity/worktree-agent-rows'
import { selectLiveAgentStatusEntriesForWorktree } from '../../../components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../../../components/sidebar/workspace-card/activity/worktree-card-status-inputs'

// Mirror imports app store singleton; redirect it to this createTestStore harness.
vi.mock('../../../store/index', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_EPOCH = 'host-epoch-1'
const T0 = 1_700_000_000_000

const KEEP_TAB = 'host-tab-keep'
const RETRACTED_TAB = 'host-tab-reviewer'
const KEEP_LEAF = '11111111-1111-4111-8111-111111111111'
const RETRACTED_LEAF = '22222222-2222-4222-8222-222222222222'

type TestStore = ReturnType<typeof createTestStore>

function mirrorTabId(hostTabId: string): string {
  return toWebTerminalSurfaceTabId(hostTabId)
}

function mirrorPaneKey(hostTabId: string, leafId: string): string {
  return makePaneKey(mirrorTabId(hostTabId), leafId)
}

const GHOST_PANE_KEY = mirrorPaneKey(RETRACTED_TAB, RETRACTED_LEAF)

/** hostAgentStatus=true models a host-hook pane; otherwise status comes from client bytes. */
function makeHostSnapshot(args: {
  snapshotVersion: number
  hostTabIds: readonly string[]
  hostNow: number
  hostAgentStatusTabIds?: readonly string[]
  hostAgentStatusState?: 'working' | 'done'
}): RuntimeMobileSessionTabsResult {
  const leafByTab: Record<string, string> = {
    [KEEP_TAB]: KEEP_LEAF,
    [RETRACTED_TAB]: RETRACTED_LEAF
  }
  return {
    worktree: WT,
    publicationEpoch: HOST_EPOCH,
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${args.hostTabIds[0]}::${leafByTab[args.hostTabIds[0]!]}`,
    activeTabType: 'terminal',
    tabs: args.hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${leafByTab[hostTabId]}`,
      title: hostTabId === RETRACTED_TAB ? 'Review origin/main' : 'Codex',
      parentTabId: hostTabId,
      leafId: leafByTab[hostTabId]!,
      isActive: index === 0,
      launchAgent: 'codex',
      status: 'ready' as const,
      terminal: `terminal-${index + 1}`,
      ...(args.hostAgentStatusTabIds?.includes(hostTabId)
        ? {
            agentStatus: {
              state: args.hostAgentStatusState ?? ('working' as const),
              prompt: `work on ${hostTabId}`,
              updatedAt: args.hostNow,
              stateStartedAt: args.hostNow - 60_000,
              agentType: 'codex',
              paneKey: makePaneKey(hostTabId, leafByTab[hostTabId]!),
              tabId: hostTabId,
              worktreeId: WT,
              stateHistory: []
            }
          }
        : {})
    }))
  }
}

/** Inventory omission empties the whole worktree mirror, including live sibling environments. Host removal tombstones differ only in epoch shape; neither proves every host tab closed. */
function makeWorktreeRemovalFrame(
  publicationEpoch = 'visibility-inventory-removal'
): RuntimeMobileSessionTabsRemovedResult {
  return {
    worktree: WT,
    publicationEpoch,
    snapshotVersion: 0,
    removed: true,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

/** Mirrors applyWebSessionTabsStorePatch: build the patch from live state, then set it. */
function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number,
  opts?: { expectChange?: boolean }
): void {
  vi.setSystemTime(now)
  const state = store.getState()
  const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now)
  if (opts?.expectChange !== false) {
    expect(patch, 'host snapshot must pass the freshness gate').not.toBe(state)
  }
  store.setState(patch as Partial<AppState>)
}

/** Replay paired pty-connection ownership: claim on transport creation, verify on byte writes, release on unmount. */
function replayClientByteStatus(
  store: TestStore,
  hostTabId: string,
  leafId: string,
  state: 'working' | 'done',
  clientNow: number
): () => void {
  vi.setSystemTime(clientNow)
  const paneKey = mirrorPaneKey(hostTabId, leafId)
  const release = registerRendererOwnedAgentStatusPane(paneKey, ENV)
  markRendererOwnedAgentStatusWrite(paneKey)
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { state, prompt: `review on ${hostTabId}`, agentType: 'codex' },
      'codex',
      undefined,
      {
        tabId: mirrorTabId(hostTabId),
        worktreeId: WT
      }
    )
  return release
}

function seedPairedClientStore(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  } as Partial<AppState>)
  return store
}

type SidebarObservation = {
  tabIds: string[]
  rowPaneKeys: string[]
}

/** Byte-identical to useWorktreeAgentRows' inputs, minus React. */
function observeSidebar(store: TestStore, now: number): SidebarObservation {
  const state = store.getState()
  const tabs = state.tabsByWorktree[WT] ?? []
  const rows = buildWorktreeAgentRows({
    tabs,
    entries: selectLiveAgentStatusEntriesForWorktree(state, WT),
    runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, WT),
    ptyIdsByTabId: selectLivePtyIdsForWorktree(state, WT),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [tab.id, state.terminalLayoutsByTabId[tab.id]])
    ),
    now
  })
  return {
    tabIds: tabs.map((tab) => tab.id),
    rowPaneKeys: rows.filter((row) => row.rowSource !== 'subagent').map((row) => row.paneKey)
  }
}

describe('a host-retracted paired tab leaves no ghost agent row behind', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('Mechanism A: a client-owned working row must not outlive its retracted tab', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'working', T0)
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('working')

    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    // Unmount releases ownership AFTER the store removes the tab, matching production ordering.
    release()
    // Identical replay cannot revisit retracted pane keys; empty patch isolates that unreachability from the sweep.
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 3, hostTabIds: [KEEP_TAB], hostNow: T0 + 3_000 }),
      T0 + 4_000,
      { expectChange: false }
    )

    const observed = observeSidebar(store, T0 + 4_000)
    const evidence = JSON.stringify(
      { observed, ghost: store.getState().agentStatusByPaneKey[GHOST_PANE_KEY] },
      null,
      2
    )
    expect(observed.tabIds, evidence).toEqual([mirrorTabId(KEEP_TAB)])
    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      `a live agent row outlived the tab the host retracted\n${evidence}`
    ).toBeUndefined()
    expect(
      observed.rowPaneKeys.filter((paneKey) => paneKey === GHOST_PANE_KEY),
      `the sidebar renders an agent row for a tab that no longer exists\n${evidence}`
    ).toEqual([])
  })

  it('a worktree tombstone frame must not sweep a client-owned row it merely un-mirrors', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'working', T0)
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('working')

    // Inventory omission clears the mirror but proves no host close; sibling environments may still publish the tab.
    applyHostSnapshot(store, makeWorktreeRemovalFrame(), T0 + 1_000)
    expect(store.getState().tabsByWorktree[WT] ?? []).toEqual([])

    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      'a tombstone frame swept a client-owned row whose tab is still open on the host'
    ).toBeDefined()
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)],
      'a tombstone frame planted a close suppressor for a tab nobody closed'
    ).toBeUndefined()

    // Returning publication must restore client-owned status authority (STA-3107).
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 + 2_000
      }),
      T0 + 3_000
    )
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(
      mirrorTabId(RETRACTED_TAB)
    )
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('working')
    release()
  })

  it('a re-mirrored tab id regains its client-owned status channel', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'working', T0)

    // Transient restart/collision retraction also plants the close marker.
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    release()
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)]
    ).toBeDefined()

    // Stable mirrored IDs can return after restart/collision repair. Presence clears close markers (real closing tabs are intent-filtered) or status stays dead forever.
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 3,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 + 3_000
      }),
      T0 + 4_000
    )
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(
      mirrorTabId(RETRACTED_TAB)
    )
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)],
      'a re-mirrored tab id kept its closed-tab marker'
    ).toBeUndefined()

    const release2 = replayClientByteStatus(
      store,
      RETRACTED_TAB,
      RETRACTED_LEAF,
      'working',
      T0 + 4_500
    )
    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state,
      'a returning mirrored tab was left permanently unable to acquire agent status'
    ).toBe('working')
    release2()
  })

  it('Mechanism A holds through the batch apply path a reconnect load uses', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'working', T0)
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('working')

    // Reconnect batches retraction then status republication; later rows must not undo the sweep.
    vi.setSystemTime(T0 + 2_000)
    const state = store.getState()
    const patch = applyFreshWebSessionTabsSnapshots(
      state,
      [
        makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
        makeHostSnapshot({
          snapshotVersion: 3,
          hostTabIds: [KEEP_TAB],
          hostNow: T0 + 1_500,
          hostAgentStatusTabIds: [KEEP_TAB]
        })
      ],
      ENV,
      T0 + 2_000
    )
    expect(patch, 'the batch must pass the freshness gate').not.toBe(state)
    store.setState(patch as Partial<AppState>)
    release()

    const observed = observeSidebar(store, T0 + 3_000)
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      mirrorTabId(KEEP_TAB)
    ])
    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      'the batch apply left a ghost row the singular apply sweeps'
    ).toBeUndefined()
    expect(observed.rowPaneKeys.filter((paneKey) => paneKey === GHOST_PANE_KEY)).toEqual([])
    // Negative safety: the batch's later snapshot still landed its host row.
    expect(store.getState().agentStatusByPaneKey[mirrorPaneKey(KEEP_TAB, KEEP_LEAF)]).toBeDefined()
  })
})
