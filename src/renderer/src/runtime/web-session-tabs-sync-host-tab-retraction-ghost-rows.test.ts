/**
 * STA-4593 incident: a paired client accumulated ~18 sidebar agent rows while the
 * host reported 4 agent records. The host had closed (retracted) the reviewer
 * tabs; every retraction stranded the client's agent-status row.
 *
 * Invariant under test: when a host snapshot retracts a mirrored terminal tab,
 * the client owes that tab the same renderer-state sweep a local closeTab runs —
 * no live agentStatusByPaneKey row, no retainedAgentsByPaneKey promotion, no
 * sidebar row for a tab that no longer exists anywhere.
 *
 * Causal boundaries pinned here (both in the paired apply path):
 *  - Mechanism A: buildMirroredAgentStatusPatch's delete loop skips client-owned
 *    pane keys (web-session-tabs-sync.ts, ownership gate), and a retracted tab's
 *    pane keys are only visitable for exactly one snapshot — so a client-owned
 *    'working' row outlives its tab forever and renders via the
 *    worktree-attributed sidebar fallback.
 *  - Mechanism C: nothing on the paired path plants
 *    recentlyClosedAgentStatusTabIds, so the retention sync promotes the
 *    vanished 'done' row into retainedAgentsByPaneKey permanently.
 *
 * Everything is injected at the seam: real snapshot mirror, real retention sync
 * logic, real sidebar row builder, fake clocks. Time is never the oracle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshots,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import {
  buildRetainedAgentsSyncSnapshot,
  collectRetainedAgentsOnDisappear
} from '../components/dashboard/useRetainedAgents'
import { buildWorktreeAgentRows } from '../components/sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from '../components/sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../components/sidebar/worktree-card-status-inputs'

// Why: web-session-tabs-sync imports the app-level store singleton; this
// harness drives a createTestStore instance instead, like its sibling suites.
vi.mock('../store', () => ({
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
type RetainedSyncAgents = ReturnType<typeof buildRetainedAgentsSyncSnapshot>['currentAgents']

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

/** The synthetic tombstone buildMissingWebSessionTabsRemovals publishes when an
 *  environment stops listing a worktree — it empties the whole worktree mirror,
 *  including tabs a still-live sibling environment publishes. The host's own
 *  notifyMobileSessionTabsRemoved tombstone differs only in epoch shape. */
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

/**
 * Byte-identical replay of pty-connection for a paired-runtime pane
 * (shouldOwnAgentStatusInRenderer = runtimeEnvironmentId !== null): claim the
 * pane at transport creation, prove it on each byte-derived write. Returns the
 * release that pty-connection's unmount disposer holds.
 */
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

/** Byte-identical replay of useRetainedAgentsSync's effect body, minus React. */
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
  retainedPaneKeys: string[]
}

/** Byte-identical to useWorktreeAgentRows' inputs, minus React. */
function observeSidebar(store: TestStore, now: number): SidebarObservation {
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

  it('control: retraction sweeps a host-authoritative pane the client never owned', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000,
        hostAgentStatusTabIds: [KEEP_TAB, RETRACTED_TAB]
      }),
      T0
    )
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]).toBeDefined()
    // A stranded migration entry renders the same ghost sidebar row through the
    // migration path, so the sweep owes it the same retirement.
    for (const [ptyId, hostTabId, leafId] of [
      ['pty-migration-ghost', RETRACTED_TAB, RETRACTED_LEAF],
      ['pty-migration-keep', KEEP_TAB, KEEP_LEAF]
    ] as const) {
      store.getState().setMigrationUnsupportedPty({
        ptyId,
        paneKey: mirrorPaneKey(hostTabId, leafId),
        tabId: mirrorTabId(hostTabId),
        worktreeId: WT,
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: T0
      })
    }

    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostTabIds: [KEEP_TAB],
        hostNow: T0 + 1_000,
        hostAgentStatusTabIds: [KEEP_TAB]
      }),
      T0 + 2_000
    )

    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]).toBeUndefined()
    expect(store.getState().migrationUnsupportedByPtyId['pty-migration-ghost']).toBeUndefined()
    // Negative safety: the surviving tab keeps its row and its migration entry.
    expect(store.getState().agentStatusByPaneKey[mirrorPaneKey(KEEP_TAB, KEEP_LEAF)]).toBeDefined()
    expect(store.getState().migrationUnsupportedByPtyId['pty-migration-keep']).toBeDefined()
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
    // The reviewer pane's status is written from parsed bytes; on a paired
    // runtime every such pane registers renderer ownership.
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'working', T0)
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('working')

    // Host closes the reviewer tab (e.g. `orca terminal` lifecycle on the host).
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    // Production ordering: the pane's unmount disposer releases ownership only
    // AFTER the store set that removed the tab.
    release()
    // Any later host activity: the retracted tab's pane keys are no longer
    // reachable by the mirror's delete loop. This snapshot repeats the previous
    // one verbatim, so an empty patch is the correct apply — with or without the
    // sweep — and only the pane keys' unreachability is under test here.
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
    // Two independent signals: the mirrored tab inventory dropped the tab...
    expect(observed.tabIds, evidence).toEqual([mirrorTabId(KEEP_TAB)])
    // ...so no live status row may survive under it, and no sidebar row may render for it.
    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      `a live agent row outlived the tab the host retracted\n${evidence}`
    ).toBeUndefined()
    expect(
      observed.rowPaneKeys.filter((paneKey) => paneKey === GHOST_PANE_KEY),
      `the sidebar renders an agent row for a tab that no longer exists\n${evidence}`
    ).toEqual([])
  })

  it('Mechanism C: a done agent whose tab the host retracted must not become a permanent retained row', () => {
    const store = seedPairedClientStore()
    let previousAgents: RetainedSyncAgents = new Map()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'done', T0)
    // The retention sync observed the done row while its tab was still live.
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 500)
    expect([...previousAgents.keys()]).toContain(GHOST_PANE_KEY)

    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    // The named half of the contract: the paired retraction plants the same
    // closed-tab marker closeTab plants, not just any retention suppressor.
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)],
      'the paired retraction did not plant the closed-tab suppressor'
    ).toBeDefined()
    release()
    // The tab's disappearance triggers the next retention sync tick.
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 2_500)

    const observed = observeSidebar(store, T0 + 3_000)
    const evidence = JSON.stringify(
      { observed, retained: store.getState().retainedAgentsByPaneKey[GHOST_PANE_KEY] },
      null,
      2
    )
    // A host retraction is a close; closes suppress retention. The paired path
    // must plant the same closed-tab marker closeTab plants.
    expect(
      store.getState().retainedAgentsByPaneKey[GHOST_PANE_KEY],
      `a host-retracted done agent was promoted into permanent retained state\n${evidence}`
    ).toBeUndefined()
    expect(
      observed.rowPaneKeys.filter((paneKey) => paneKey === GHOST_PANE_KEY),
      `the sidebar renders a retained ghost row for a tab that no longer exists\n${evidence}`
    ).toEqual([])
  })

  it('control: the retention suppressor works when the closed-tab marker is planted', () => {
    const store = seedPairedClientStore()
    let previousAgents: RetainedSyncAgents = new Map()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 - 1_000
      }),
      T0
    )
    const release = replayClientByteStatus(store, RETRACTED_TAB, RETRACTED_LEAF, 'done', T0)
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 500)

    // The local close path's suppressor-aware removal: sweeps the row AND
    // plants recentlyClosedAgentStatusTabIds so retention cannot resurrect it.
    store.getState().dropAgentStatusByTabPrefix(mirrorTabId(RETRACTED_TAB), { worktreeId: WT })
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    release()
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 2_500)

    expect(store.getState().retainedAgentsByPaneKey[GHOST_PANE_KEY]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]).toBeUndefined()
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

    // One environment stops listing the worktree. The tombstone clears the whole
    // mirror, but it is not a host close: the tab is still open on the host, and
    // another paired environment may still be publishing it.
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

    // The worktree comes back on the next real publication: the tab returns, and
    // its client-owned status row must return with it (STA-3107 status authority).
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

  it("the host's own removal tombstone (removed:<epoch>) must not sweep either", () => {
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

    // notifyMobileSessionTabsRemoved publishes removed:true under a
    // removed:<base36> epoch — only the `removed` flag identifies it.
    applyHostSnapshot(store, makeWorktreeRemovalFrame('removed:k7q2xz'), T0 + 1_000)
    expect(store.getState().tabsByWorktree[WT] ?? []).toEqual([])

    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      'a host removal tombstone swept a client-owned row it merely un-mirrors'
    ).toBeDefined()
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)],
      'a host removal tombstone planted a close suppressor for a tab nobody closed'
    ).toBeUndefined()
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

    // A transient omission — host restart subset frame, cross-host collision
    // replacement — retracts the tab and plants the closed-tab marker.
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    release()
    expect(
      store.getState().recentlyClosedAgentStatusTabIds[mirrorTabId(RETRACTED_TAB)]
    ).toBeDefined()

    // The host publishes the same tab id again (post-restart republication or
    // the collision repair replay). Mirrored ids are stable, and the close-intent
    // filter holds genuinely closing tabs out of snapshots — so presence is
    // authoritative: the marker must lift, or the returning tab is
    // agent-status-dead for the rest of the session.
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

    // The returning pane's byte-derived status must land again.
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

  it('a retract-and-return flap must not strand a suppressor that eats a later real retention', () => {
    const store = seedPairedClientStore()
    let previousAgents: RetainedSyncAgents = new Map()
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
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 500)

    // The flap: a transient retraction and the return land inside ONE retention
    // interval (React batches same-task store commits into a single effect pass).
    // The pane stays mounted throughout, so the sweep found the client-owned row
    // live and planted its one-shot suppressor with no disappearance to consume
    // it — the pane's next live write is what must lift it (setAgentStatus's
    // fresh-status suppressor lift), or it eats a later real retention.
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostTabIds: [KEEP_TAB], hostNow: T0 + 1_000 }),
      T0 + 2_000
    )
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 3,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 + 2_500
      }),
      T0 + 3_000
    )
    // The still-mounted pane finishes its run cleanly and rewrites its row.
    vi.setSystemTime(T0 + 3_500)
    markRendererOwnedAgentStatusWrite(GHOST_PANE_KEY)
    store
      .getState()
      .setAgentStatus(
        GHOST_PANE_KEY,
        { state: 'done', prompt: 'review finished', agentType: 'codex' },
        'codex',
        undefined,
        { tabId: mirrorTabId(RETRACTED_TAB), worktreeId: WT }
      )
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 4_000)
    expect(store.getState().agentStatusByPaneKey[GHOST_PANE_KEY]?.state).toBe('done')

    // Much later the pane unmounts and the host's next snapshot omits its status:
    // the mirror's delete loop removes the no-longer-client-owned done row with no
    // suppressor — the exact live→gone transition retention exists to catch.
    release()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 4,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 + 600_000
      }),
      T0 + 601_000
    )
    expect(
      store.getState().agentStatusByPaneKey[GHOST_PANE_KEY],
      'precondition: the released done row must be removed by the mirror delete loop'
    ).toBeUndefined()
    previousAgents = replayRetainedAgentsSync(store, previousAgents, T0 + 601_500)

    expect(
      store.getState().retainedAgentsByPaneKey[GHOST_PANE_KEY],
      'a stranded retraction suppressor ate a legitimate done-agent retention'
    ).toBeDefined()
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

    // A reconnect delivers everything missed as ONE batch: the retraction, then
    // a later snapshot that touches agent status again — the batch's final
    // record republication must not undo the sweep.
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
