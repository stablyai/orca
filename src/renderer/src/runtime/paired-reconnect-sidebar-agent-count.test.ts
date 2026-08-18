/**
 * STA-3107: a paired client working against a remote Orca host is slept
 * (laptop closed), then woken. Every terminal tab is still open and still has a
 * live host PTY, but the sidebar shows fewer agents than there are tabs.
 *
 * Invariant under test: a mirrored pane that still has a live host PTY and had
 * an agent keeps its sidebar row across a sleep/wake reconnect. A quiet agent
 * must DECAY (buildWorktreeAgentRows already renders a stale entry as 'idle'),
 * exactly like a local pane — it must not be erased.
 *
 * Causal boundary: buildMirroredAgentStatusPatch's delete loop in
 * web-session-tabs-sync.ts. A host snapshot that carries no agentStatus for a
 * pane deletes the client's mirrored entry unless the client's own entry is
 * still FRESH. Sleeping past AGENT_STATUS_STALE_AFTER_MS makes every
 * client-owned entry stale by definition, so the first post-wake snapshot
 * erases the row of every pane whose status only the client ever wrote.
 *
 * Everything is injected at the seam: the real host-snapshot mirror and the
 * real sidebar row builder, driven by fake clocks. Elapsed time is never the
 * oracle — the row/tab inventory is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
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
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
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
/** The laptop was closed well past the agent-status freshness boundary. */
const LONG_SLEEP_MS = AGENT_STATUS_STALE_AFTER_MS * 6
/** A blip the client rides out without its own status going stale. */
const BRIEF_DROP_MS = 5_000

type TestStore = ReturnType<typeof createTestStore>

type PaneSpec = {
  hostTabId: string
  leafId: string
  agentType: 'claude' | 'omp'
  /** Which writer publishes this pane's agent status. */
  statusSource: 'host-hook' | 'client-bytes'
  /** Host-resolved surface title. */
  title: string
}

function leafUuid(n: number): string {
  return `1111111${n}-1111-4111-8111-111111111111`
}

/**
 * Six OMP/Claude panes matching the report. Host-hook panes model an agent the
 * host tracks itself; client-bytes panes model the OSC-only panes whose status
 * only this renderer ever parses (the host publishes no agentStatus for them).
 */
const PANES: PaneSpec[] = [
  {
    hostTabId: 'host-tab-1',
    leafId: leafUuid(1),
    agentType: 'omp',
    statusSource: 'host-hook',
    title: 'OMP'
  },
  {
    hostTabId: 'host-tab-2',
    leafId: leafUuid(2),
    agentType: 'omp',
    statusSource: 'host-hook',
    title: 'OMP'
  },
  {
    hostTabId: 'host-tab-3',
    leafId: leafUuid(3),
    agentType: 'omp',
    statusSource: 'client-bytes',
    title: 'Terminal'
  },
  {
    hostTabId: 'host-tab-4',
    leafId: leafUuid(4),
    agentType: 'omp',
    statusSource: 'client-bytes',
    title: 'Terminal'
  },
  {
    hostTabId: 'host-tab-5',
    leafId: leafUuid(5),
    agentType: 'claude',
    statusSource: 'host-hook',
    title: 'Claude Code'
  },
  {
    hostTabId: 'host-tab-6',
    leafId: leafUuid(6),
    agentType: 'claude',
    statusSource: 'client-bytes',
    title: 'Terminal'
  }
]

const CLIENT_OWNED_PANES = PANES.filter((pane) => pane.statusSource === 'client-bytes')

function mirrorTabId(pane: PaneSpec): string {
  return toWebTerminalSurfaceTabId(pane.hostTabId)
}

function mirrorPaneKey(pane: PaneSpec): string {
  return makePaneKey(mirrorTabId(pane), pane.leafId)
}

/** `hostNow` stamps host-side status: the remote machine keeps working while the laptop is closed. */
function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
}): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: HOST_EPOCH,
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${PANES[0]!.hostTabId}::${PANES[0]!.leafId}`,
    activeTabType: 'terminal',
    tabs: PANES.map((pane, index) => ({
      type: 'terminal' as const,
      id: `${pane.hostTabId}::${pane.leafId}`,
      title: pane.title,
      parentTabId: pane.hostTabId,
      leafId: pane.leafId,
      isActive: index === 0,
      launchAgent: pane.agentType,
      status: 'ready' as const,
      terminal: `terminal-${index + 1}`,
      ...(pane.statusSource === 'host-hook'
        ? {
            agentStatus: {
              state: 'working' as const,
              prompt: `work on ${pane.hostTabId}`,
              updatedAt: args.hostNow,
              stateStartedAt: args.hostNow - 60_000,
              agentType: pane.agentType,
              paneKey: makePaneKey(pane.hostTabId, pane.leafId),
              tabId: pane.hostTabId,
              worktreeId: WT,
              stateHistory: []
            }
          }
        : {})
    }))
  }
}

/** Mirrors applyWebSessionTabsStorePatch: build the patch from live state, then set it. */
function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): void {
  vi.setSystemTime(now)
  const state = store.getState()
  const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now)
  expect(patch, 'host snapshot must pass the freshness gate').not.toBe(state)
  store.setState(patch as Partial<AppState>)
}

/**
 * Byte-identical replay of what pty-connection does for a remote pane
 * (shouldOwnAgentStatusInRenderer = runtimeEnvironmentId !== null): claim the
 * pane at transport creation, then prove the claim on each byte-derived write.
 * Returns the pane's release, which pty-connection holds for dispose().
 */
function replayClientByteStatus(store: TestStore, pane: PaneSpec, clientNow: number): () => void {
  vi.setSystemTime(clientNow)
  const paneKey = mirrorPaneKey(pane)
  const release = registerRendererOwnedAgentStatusPane(paneKey, ENV)
  markRendererOwnedAgentStatusWrite(paneKey)
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { state: 'working', prompt: `work on ${pane.hostTabId}`, agentType: pane.agentType },
      pane.agentType,
      undefined,
      { tabId: mirrorTabId(pane), worktreeId: WT }
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
  tabsWithLivePty: string[]
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
    tabsWithLivePty: Object.keys(selectLivePtyIdsForWorktree(state, WT))
  }
}

/** Attaches, runs one turn on every pane, then drops the transport for `awayMs`
 *  and lets the host republish its live state on reconnect. */
function runSleepWakeReconnect(store: TestStore, awayMs: number): SidebarObservation {
  applyHostSnapshot(store, makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 - 1_000 }), T0)
  for (const pane of CLIENT_OWNED_PANES) {
    replayClientByteStatus(store, pane, T0)
  }
  const attached = observeSidebar(store, T0)
  expect(attached.rowPaneKeys, 'precondition: every pane has a row while attached').toHaveLength(
    PANES.length
  )

  const wakeAt = T0 + awayMs
  applyHostSnapshot(
    store,
    makeHostSnapshot({ snapshotVersion: 2, hostNow: wakeAt - 1_000 }),
    wakeAt
  )
  return observeSidebar(store, wakeAt)
}

describe('STA-3107: sidebar agent rows survive a paired-client sleep/wake reconnect', () => {
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

  it('control: a brief transport drop keeps every pane in the sidebar', () => {
    const store = seedPairedClientStore()
    const reconnected = runSleepWakeReconnect(store, BRIEF_DROP_MS)

    expect(reconnected.tabIds).toHaveLength(PANES.length)
    expect(reconnected.rowPaneKeys.sort()).toEqual(PANES.map(mirrorPaneKey).sort())
  })

  it('keeps a sidebar row for every still-live pane after a long sleep', () => {
    const store = seedPairedClientStore()
    const reconnected = runSleepWakeReconnect(store, LONG_SLEEP_MS)
    const evidence = `after wake:\n${JSON.stringify(reconnected, null, 2)}`

    // Two independent signals prove the panes are alive, so a missing row is a
    // sidebar defect and not an honest report of a dead pane: the tab is still
    // in the tab bar, and the host still publishes a live PTY for it.
    expect(reconnected.tabIds, evidence).toHaveLength(PANES.length)
    expect(reconnected.tabsWithLivePty, evidence).toHaveLength(PANES.length)
    expect(reconnected.rowPaneKeys.sort(), evidence).toEqual(PANES.map(mirrorPaneKey).sort())
  })

  it('the erased rows are exactly the panes whose status only the client wrote', () => {
    const store = seedPairedClientStore()
    const reconnected = runSleepWakeReconnect(store, LONG_SLEEP_MS)
    const missing = PANES.map(mirrorPaneKey).filter(
      (paneKey) => !reconnected.rowPaneKeys.includes(paneKey)
    )

    // Pins the causal boundary: host-authoritative panes are republished with a
    // fresh host timestamp and are never at risk; only client-owned panes are.
    expect(missing).toEqual([])
  })

  it('still cedes a pane this renderer never wrote status for', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(store, makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 - 1_000 }), T0)
    // A remote pane claims ownership at transport creation but has produced no
    // byte-derived status, so the host stays authoritative for it.
    const unwritten = CLIENT_OWNED_PANES[0]!
    registerRendererOwnedAgentStatusPane(mirrorPaneKey(unwritten), ENV)
    store
      .getState()
      .setAgentStatus(
        mirrorPaneKey(unwritten),
        { state: 'working', prompt: 'host-sourced', agentType: unwritten.agentType },
        unwritten.agentType,
        undefined,
        { tabId: mirrorTabId(unwritten), worktreeId: WT }
      )
    const wakeAt = T0 + LONG_SLEEP_MS
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostNow: wakeAt - 1_000 }),
      wakeAt
    )

    expect(store.getState().agentStatusByPaneKey[mirrorPaneKey(unwritten)]).toBeUndefined()
  })

  it('releases authority on pane teardown so the host can retire the row', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(store, makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 - 1_000 }), T0)
    const releases = CLIENT_OWNED_PANES.map((pane) => replayClientByteStatus(store, pane, T0))
    for (const release of releases) {
      release()
    }

    const wakeAt = T0 + LONG_SLEEP_MS
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostNow: wakeAt - 1_000 }),
      wakeAt
    )

    for (const pane of CLIENT_OWNED_PANES) {
      expect(store.getState().agentStatusByPaneKey[mirrorPaneKey(pane)]).toBeUndefined()
    }
  })
})
