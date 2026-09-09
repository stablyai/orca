import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

type StartEvent = {
  kind: 'start'
  worktreeId: string
  tabId: string
  ptyId: string
  paneId: number
  leafId: string
  drivesTabTitle: boolean
  restoreTitleOnRegister: boolean
}
type DisposeEvent = { kind: 'dispose'; worktreeId: string; tabId: string; ptyId: string }
type ClearTitleEvent = { kind: 'clearTitle'; tabId: string; paneId: number }
type DiscardEvent = { kind: 'discard'; ptyId: string }
type WatcherEvent = StartEvent | DisposeEvent | ClearTitleEvent | DiscardEvent

let events: WatcherEvent[] = []

const startParkedTerminalByteWatcher = vi.fn((options: ParkedTerminalByteWatcherOptions) => {
  events.push({
    kind: 'start',
    worktreeId: options.worktreeId,
    tabId: options.tabId,
    ptyId: options.ptyId,
    paneId: options.paneId,
    leafId: options.leafId,
    drivesTabTitle: options.drivesTabTitle === true,
    restoreTitleOnRegister: options.restoreTitleOnRegister === true
  })
  return () => {
    events.push({
      kind: 'dispose',
      worktreeId: options.worktreeId,
      tabId: options.tabId,
      ptyId: options.ptyId
    })
  }
})

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: (options: ParkedTerminalByteWatcherOptions) =>
    startParkedTerminalByteWatcher(options)
}))

vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: () => () => {}
}))

vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: (ptyId: string) => {
    events.push({ kind: 'discard', ptyId })
  },
  hasPreHandlerPtyExit: () => false
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: () => {}
}))

type TabModel = { id: string; ptyId: string | null }
type MockStoreState = {
  tabsByWorktree: Record<string, TabModel[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: unknown
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<string, { status: null; checkedAt: number }>
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  setRuntimePaneTitle: () => void
  clearTabLaunchAgent: () => void
  setTabLayout: () => void
  updateTabTitle: () => void
  markUnverifiedPtyLoss: () => void
  isPtyShutdownPending: () => boolean
  suppressedPtyExitIds: Record<string, true>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchers,
  syncParkedTerminalTabWatchersForWorkspaces,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-parked-tab-watchers'
import { capturedPanesByTabId, parkedWatchersByTabId } from './terminal-parked-watcher-registry'

const leafId = (index: number): string =>
  `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`

function makeStore(): MockStoreState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    settings: null,
    runtimeStatusByEnvironmentId: new Map(),
    clearRuntimePaneTitle: (tabId: string, paneId: number) => {
      events.push({ kind: 'clearTitle', tabId, paneId })
    },
    setRuntimePaneTitle: () => {},
    clearTabLaunchAgent: () => {},
    setTabLayout: () => {},
    updateTabTitle: () => {},
    markUnverifiedPtyLoss: () => {},
    isPtyShutdownPending: () => false,
    suppressedPtyExitIds: {}
  }
}

/** Counts entries visited by `for...of` over the module-level registries. */
function instrumentRegistryIteration(): { count: number; restore: () => void } {
  const counter = { count: 0, restore: () => {} }
  const patched: Map<unknown, unknown>[] = [
    parkedWatchersByTabId as Map<unknown, unknown>,
    capturedPanesByTabId as Map<unknown, unknown>
  ]
  for (const map of patched) {
    Object.defineProperty(map, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function* (this: Map<unknown, unknown>) {
        for (const entry of Map.prototype.entries.call(this)) {
          counter.count += 1
          yield entry
        }
      }
    })
  }
  counter.restore = () => {
    for (const map of patched) {
      Reflect.deleteProperty(map, Symbol.iterator)
    }
  }
  return counter
}

describe('parked terminal watcher batch synchronization', () => {
  beforeEach(() => {
    events = []
    mockStoreState = makeStore()
    clearTerminalProviderSnapshotCapabilities()
  })

  afterEach(() => {
    pruneParkedTerminalWatchers(new Set())
    capturedPanesByTabId.clear()
    events = []
    vi.clearAllMocks()
    clearTerminalProviderSnapshotCapabilities()
  })

  describe('registry scan cost at the real-profile scale', () => {
    // The user's profile: 423 workspace surfaces, 382 terminal tabs.
    const WORKSPACE_COUNT = 423
    const TAB_COUNT = 382

    function seedRegistries(): {
      workspaceIds: string[]
      tabsByWorktreeId: Map<string, TabModel[]>
    } {
      const workspaceIds = Array.from(
        { length: WORKSPACE_COUNT },
        (_, index) => `repo::/worktree-${index}`
      )
      const tabsByWorktreeId = new Map<string, TabModel[]>(
        workspaceIds.map((workspaceId) => [workspaceId, [] as TabModel[]])
      )
      for (let index = 0; index < TAB_COUNT; index += 1) {
        const worktreeId = workspaceIds[index % WORKSPACE_COUNT]
        const tabId = `tab-${index}`
        const ptyId = `${worktreeId}@@session-${index}`
        tabsByWorktreeId.get(worktreeId)!.push({ id: tabId, ptyId })
        // A live, already-parked tab: present in both registries, nothing to
        // dispose and nothing to start, so the pass is a pure registry scan.
        parkedWatchersByTabId.set(tabId, {
          worktreeId,
          tabPtyId: ptyId,
          paneIdByPtyId: new Map([[ptyId, 1]]),
          disposersByPtyId: new Map()
        })
        captureParkedTerminalPaneCandidates(tabId, worktreeId, [
          { ptyId, paneId: 1, leafId: leafId(index), drivesTabTitle: true }
        ])
      }
      return { workspaceIds, tabsByWorktreeId }
    }

    it('collapses surfaces x registry scans into one scan of each registry', () => {
      const { workspaceIds, tabsByWorktreeId } = seedRegistries()
      const registryRows = parkedWatchersByTabId.size + capturedPanesByTabId.size
      expect(registryRows).toBe(TAB_COUNT * 2)

      const perSurface = instrumentRegistryIteration()
      for (const workspaceId of workspaceIds) {
        syncParkedTerminalTabWatchers({
          worktreeId: workspaceId,
          tabs: tabsByWorktreeId.get(workspaceId)!,
          parkedTabIds: new Set()
        })
      }
      const perSurfaceVisits = perSurface.count
      perSurface.restore()

      const batched = instrumentRegistryIteration()
      const entries = new Map<string, ParkedTerminalTabWatcherSyncEntry>(
        workspaceIds.map((workspaceId) => [
          workspaceId,
          { tabs: tabsByWorktreeId.get(workspaceId)!, parkedTabIds: new Set<string>() }
        ])
      )
      syncParkedTerminalTabWatchersForWorkspaces(entries)
      const batchedVisits = batched.count
      batched.restore()

      // Old shape: every surface re-walks both registries in full.
      expect(perSurfaceVisits).toBe(WORKSPACE_COUNT * registryRows)
      // New shape: each registry is walked exactly once for the whole pass.
      expect(batchedVisits).toBe(registryRows)
      expect(perSurfaceVisits / batchedVisits).toBeGreaterThan(400)
    })
  })

  describe('start/dispose decisions match the per-surface path', () => {
    type Scenario = {
      name: string
      workspaces: {
        worktreeId: string
        tabs: TabModel[]
        parkedTabIds: string[]
        restoreTitleOnStartTabIds?: string[]
      }[]
      /** Watcher rows already in the registry when the pass runs. */
      preParkedTabs: { worktreeId: string; tabId: string; ptyId: string; withDisposer: boolean }[]
      /** Captures for tabs that may or may not still be live. */
      preCapturedTabs: { worktreeId: string; tabId: string; ptyId: string | null }[]
    }

    const WORKTREE_A = 'repo::/alpha'
    const WORKTREE_B = 'repo::/beta'
    const WORKTREE_C = 'repo::/gamma'

    const pty = (worktreeId: string, index: number): string => `${worktreeId}@@session-${index}`

    const scenarios: Scenario[] = [
      {
        name: 'cold start: nothing parked yet, two workspaces park every tab',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [
              { id: 'a1', ptyId: pty(WORKTREE_A, 1) },
              { id: 'a2', ptyId: pty(WORKTREE_A, 2) }
            ],
            parkedTabIds: ['a1', 'a2']
          },
          {
            worktreeId: WORKTREE_B,
            tabs: [{ id: 'b1', ptyId: pty(WORKTREE_B, 1) }],
            parkedTabIds: ['b1']
          },
          { worktreeId: WORKTREE_C, tabs: [], parkedTabIds: [] }
        ],
        preParkedTabs: [],
        preCapturedTabs: []
      },
      {
        name: 'reveal: a parked workspace drops out of the parked set',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [
              { id: 'a1', ptyId: pty(WORKTREE_A, 1) },
              { id: 'a2', ptyId: pty(WORKTREE_A, 2) }
            ],
            parkedTabIds: []
          },
          {
            worktreeId: WORKTREE_B,
            tabs: [{ id: 'b1', ptyId: pty(WORKTREE_B, 1) }],
            parkedTabIds: ['b1']
          }
        ],
        preParkedTabs: [
          { worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 1), withDisposer: true },
          { worktreeId: WORKTREE_A, tabId: 'a2', ptyId: pty(WORKTREE_A, 2), withDisposer: true }
        ],
        preCapturedTabs: [
          { worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 1) },
          { worktreeId: WORKTREE_A, tabId: 'a2', ptyId: pty(WORKTREE_A, 2) }
        ]
      },
      {
        name: 'closed tabs: registry rows and captures outlive their tabs',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [{ id: 'a1', ptyId: pty(WORKTREE_A, 1) }],
            parkedTabIds: ['a1']
          },
          { worktreeId: WORKTREE_B, tabs: [], parkedTabIds: [] }
        ],
        preParkedTabs: [
          {
            worktreeId: WORKTREE_A,
            tabId: 'a-closed',
            ptyId: pty(WORKTREE_A, 9),
            withDisposer: true
          },
          {
            worktreeId: WORKTREE_B,
            tabId: 'b-closed',
            ptyId: pty(WORKTREE_B, 9),
            withDisposer: true
          }
        ],
        preCapturedTabs: [
          { worktreeId: WORKTREE_A, tabId: 'a-closed', ptyId: pty(WORKTREE_A, 9) },
          { worktreeId: WORKTREE_B, tabId: 'b-closed', ptyId: pty(WORKTREE_B, 9) },
          { worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 1) }
        ]
      },
      {
        name: 're-minted pty: a parked tab wakes with a fresh pty id',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [{ id: 'a1', ptyId: pty(WORKTREE_A, 2) }],
            parkedTabIds: ['a1'],
            restoreTitleOnStartTabIds: ['a1']
          },
          {
            worktreeId: WORKTREE_B,
            tabs: [{ id: 'b1', ptyId: pty(WORKTREE_B, 1) }],
            parkedTabIds: ['b1']
          }
        ],
        preParkedTabs: [
          { worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 1), withDisposer: true }
        ],
        preCapturedTabs: [{ worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 2) }]
      },
      {
        name: 'unknown worktree rows: registry holds a workspace absent from this pass',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [{ id: 'a1', ptyId: pty(WORKTREE_A, 1) }],
            parkedTabIds: ['a1']
          }
        ],
        preParkedTabs: [
          { worktreeId: WORKTREE_C, tabId: 'c1', ptyId: pty(WORKTREE_C, 1), withDisposer: true }
        ],
        preCapturedTabs: [{ worktreeId: WORKTREE_C, tabId: 'c1', ptyId: pty(WORKTREE_C, 1) }]
      },
      {
        name: 'tombstone rows: a pinned-close entry with no live disposers',
        workspaces: [
          {
            worktreeId: WORKTREE_A,
            tabs: [{ id: 'a1', ptyId: pty(WORKTREE_A, 1) }],
            parkedTabIds: []
          },
          {
            worktreeId: WORKTREE_B,
            tabs: [{ id: 'b1', ptyId: pty(WORKTREE_B, 1) }],
            parkedTabIds: ['b1']
          }
        ],
        preParkedTabs: [
          { worktreeId: WORKTREE_A, tabId: 'a1', ptyId: pty(WORKTREE_A, 1), withDisposer: false }
        ],
        preCapturedTabs: [{ worktreeId: WORKTREE_B, tabId: 'b1', ptyId: pty(WORKTREE_B, 1) }]
      }
    ]

    type Outcome = {
      eventsByWorktree: Record<string, WatcherEvent[]>
      registry: readonly (readonly [
        string,
        { worktreeId: string; tabPtyId: string | null; ptyIds: string[] }
      ])[]
      captures: string[]
    }

    async function seedAndRun(
      scenario: Scenario,
      run: (scenario: Scenario) => void
    ): Promise<Outcome> {
      pruneParkedTerminalWatchers(new Set())
      capturedPanesByTabId.clear()
      clearTerminalProviderSnapshotCapabilities()
      mockStoreState = makeStore()
      const allPtyIds = new Set<string>()
      for (const workspace of scenario.workspaces) {
        for (const tab of workspace.tabs) {
          if (tab.ptyId) {
            allPtyIds.add(tab.ptyId)
          }
        }
      }
      for (const row of [...scenario.preParkedTabs, ...scenario.preCapturedTabs]) {
        if (row.ptyId) {
          allPtyIds.add(row.ptyId)
        }
      }
      await synchronizeTerminalProviderSnapshotCapabilities(Array.from(allPtyIds), async (ids) =>
        ids.map((id) => ({ id, authoritative: true }))
      )
      let paneOrdinal = 0
      for (const row of scenario.preParkedTabs) {
        paneOrdinal += 1
        parkedWatchersByTabId.set(row.tabId, {
          worktreeId: row.worktreeId,
          tabPtyId: row.ptyId,
          paneIdByPtyId: new Map([[row.ptyId, paneOrdinal]]),
          disposersByPtyId: row.withDisposer
            ? new Map([
                [
                  row.ptyId,
                  () => {
                    events.push({
                      kind: 'dispose',
                      worktreeId: row.worktreeId,
                      tabId: row.tabId,
                      ptyId: row.ptyId
                    })
                  }
                ]
              ])
            : new Map()
        })
      }
      for (const [index, row] of scenario.preCapturedTabs.entries()) {
        captureParkedTerminalPaneCandidates(row.tabId, row.worktreeId, [
          { ptyId: row.ptyId, paneId: 100 + index, leafId: leafId(index + 1), drivesTabTitle: true }
        ])
      }
      events = []
      run(scenario)

      const eventsByWorktree: Record<string, WatcherEvent[]> = {}
      for (const event of events) {
        const key = 'worktreeId' in event ? event.worktreeId : 'shared'
        ;(eventsByWorktree[key] ??= []).push(event)
      }
      // Why per-worktree, not one global sequence: batching deliberately hoists
      // every workspace's dispose sweep ahead of every workspace's start pass.
      // Registry rows are tab-id keyed and a tab belongs to exactly one
      // worktree, so that reorder crosses only disjoint tab sets. `shared`
      // events (pane-title clears, pre-handler discards) are compared as a
      // multiset for the same reason.
      for (const key of Object.keys(eventsByWorktree)) {
        if (key === 'shared') {
          eventsByWorktree[key] = [...eventsByWorktree[key]].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
          )
        }
      }
      return {
        eventsByWorktree,
        registry: Array.from(
          parkedWatchersByTabId,
          ([tabId, entry]) =>
            [
              tabId,
              {
                worktreeId: entry.worktreeId,
                tabPtyId: entry.tabPtyId,
                ptyIds: Array.from(entry.disposersByPtyId.keys()).sort()
              }
            ] as const
        ).sort((left, right) => left[0].localeCompare(right[0])),
        captures: Array.from(capturedPanesByTabId.keys()).sort()
      }
    }

    const runPerSurface = (scenario: Scenario): void => {
      for (const workspace of scenario.workspaces) {
        syncParkedTerminalTabWatchers({
          worktreeId: workspace.worktreeId,
          tabs: workspace.tabs,
          parkedTabIds: new Set(workspace.parkedTabIds),
          ...(workspace.restoreTitleOnStartTabIds
            ? { restoreTitleOnStartTabIds: new Set(workspace.restoreTitleOnStartTabIds) }
            : {})
        })
      }
    }

    const runBatched = (scenario: Scenario): void => {
      syncParkedTerminalTabWatchersForWorkspaces(
        new Map(
          scenario.workspaces.map((workspace) => [
            workspace.worktreeId,
            {
              tabs: workspace.tabs,
              parkedTabIds: new Set(workspace.parkedTabIds),
              ...(workspace.restoreTitleOnStartTabIds
                ? { restoreTitleOnStartTabIds: new Set(workspace.restoreTitleOnStartTabIds) }
                : {})
            }
          ])
        )
      )
    }

    for (const scenario of scenarios) {
      it(`decides identically — ${scenario.name}`, async () => {
        const perSurface = await seedAndRun(scenario, runPerSurface)
        const batched = await seedAndRun(scenario, runBatched)
        expect(batched).toEqual(perSurface)
        // Guard against a vacuous comparison of two empty outcomes.
        expect(
          Object.values(perSurface.eventsByWorktree).some((list) => list.length > 0) ||
            perSurface.registry.length > 0
        ).toBe(true)
      })
    }
  })
})
