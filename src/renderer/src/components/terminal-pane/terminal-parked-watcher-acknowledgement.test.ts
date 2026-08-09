import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ParkedTabWatcherEntry,
  ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = 'ssh:connection-1@@pty-1'
const SECOND_PTY_ID = 'ssh:connection-1@@pty-2'

const watcherMock = vi.hoisted(() => ({
  mode: 'complete' as 'complete' | 'partial' | 'throw',
  starts: [] as { ptyId: string; dispose: ReturnType<typeof vi.fn> }[]
}))

vi.mock('./terminal-parked-pty-watcher', () => ({
  collapseParkedExitedLeaf: vi.fn(),
  startParkedPtyWatcher: (args: {
    pane: ParkedTerminalPaneCapture
    entry: ParkedTabWatcherEntry
  }) => {
    if (watcherMock.mode === 'throw') {
      throw new Error('watcher start failed')
    }
    if (!args.pane.ptyId || (watcherMock.mode === 'partial' && args.pane.ptyId === SECOND_PTY_ID)) {
      return
    }
    const dispose = vi.fn()
    watcherMock.starts.push({ ptyId: args.pane.ptyId, dispose })
    args.entry.paneIdByPtyId.set(args.pane.ptyId, args.pane.paneId)
    args.entry.disposersByPtyId.set(args.pane.ptyId, dispose)
  }
}))

vi.mock('./pty-pre-handler-buffer', () => ({ discardPreHandlerPtyState: vi.fn() }))

type MockTab = { id: string; ptyId: string | null; generation?: number }
type MockStoreState = {
  tabsByWorktree: Record<string, MockTab[]>
  terminalLayoutsByTabId: Record<string, object>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<string, { status: null }>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
}

let state: MockStoreState

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

import {
  captureParkedTerminalPaneCandidates,
  getParkedTerminalWatcherTabIds,
  planParkedTerminalTabWatcherCoverage,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchersWithAcknowledgements
} from './terminal-parked-tab-watchers'

function capture(panes?: ParkedTerminalPaneCapture[]): void {
  captureParkedTerminalPaneCandidates(
    TAB_ID,
    WORKTREE_ID,
    1,
    panes ?? [
      { leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID, paneId: 1, drivesTabTitle: true },
      { leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID, paneId: 2, drivesTabTitle: false }
    ]
  )
}

function planAndSync() {
  const tab = state.tabsByWorktree[WORKTREE_ID][0]
  const plan = planParkedTerminalTabWatcherCoverage(WORKTREE_ID, tab)
  const acknowledgements = syncParkedTerminalTabWatchersWithAcknowledgements({
    worktreeId: WORKTREE_ID,
    tabs: [tab],
    parkedTabIds: new Set([TAB_ID]),
    coveragePlansByTabId: new Map([[TAB_ID, plan]])
  })
  return { plan, acknowledgement: acknowledgements[0] }
}

describe('parked watcher sync acknowledgement', () => {
  beforeEach(() => {
    state = {
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 1 }]
      },
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      settings: null,
      runtimeStatusByEnvironmentId: new Map(),
      clearRuntimePaneTitle: vi.fn(),
      setRuntimePaneTitle: vi.fn()
    }
    watcherMock.mode = 'complete'
    watcherMock.starts.length = 0
    capture()
  })

  afterEach(() => {
    pruneParkedTerminalWatchers(new Set())
    vi.clearAllMocks()
  })

  it('acknowledges only registry-committed coverage for every planned PTY', () => {
    const { plan, acknowledgement } = planAndSync()

    expect(plan.status).toBe('covered')
    expect(acknowledgement).toEqual({
      status: 'covering',
      tabId: TAB_ID,
      materialKey: plan.materialKey,
      watchedPtyIds: [FIRST_PTY_ID, SECOND_PTY_ID]
    })
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('returns failure and rolls back a partial watcher start', () => {
    watcherMock.mode = 'partial'

    const { acknowledgement } = planAndSync()

    expect(acknowledgement).toMatchObject({
      status: 'failed',
      reason: 'watcher-coverage-incomplete',
      watchedPtyIds: [FIRST_PTY_ID]
    })
    expect(watcherMock.starts[0].dispose).toHaveBeenCalledOnce()
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('turns a thrown watcher start into an effect-safe failure result', () => {
    watcherMock.mode = 'throw'

    expect(planAndSync().acknowledgement).toMatchObject({
      status: 'failed',
      reason: 'watcher-start-failed'
    })
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('rejects a same-PTY-set leaf swap against the requested material plan', () => {
    const tab = state.tabsByWorktree[WORKTREE_ID][0]
    const requested = planParkedTerminalTabWatcherCoverage(WORKTREE_ID, tab)
    capture([
      { leafId: FIRST_LEAF_ID, ptyId: SECOND_PTY_ID, paneId: 7, drivesTabTitle: true },
      { leafId: SECOND_LEAF_ID, ptyId: FIRST_PTY_ID, paneId: 8, drivesTabTitle: false }
    ])

    const [acknowledgement] = syncParkedTerminalTabWatchersWithAcknowledgements({
      worktreeId: WORKTREE_ID,
      tabs: [tab],
      parkedTabIds: new Set([TAB_ID]),
      coveragePlansByTabId: new Map([[TAB_ID, requested]])
    })

    expect(acknowledgement).toMatchObject({ status: 'failed', reason: 'material-changed' })
    expect(watcherMock.starts).toEqual([])
  })

  it('restarts established watchers when a new plan swaps the same PTY set', () => {
    planAndSync()
    const originalWatchers = watcherMock.starts.slice()
    capture([
      { leafId: FIRST_LEAF_ID, ptyId: SECOND_PTY_ID, paneId: 7, drivesTabTitle: true },
      { leafId: SECOND_LEAF_ID, ptyId: FIRST_PTY_ID, paneId: 8, drivesTabTitle: false }
    ])

    const { acknowledgement } = planAndSync()

    expect(acknowledgement.status).toBe('covering')
    expect(watcherMock.starts).toHaveLength(4)
    expect(originalWatchers.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true)
  })

  it('rejects a stale tab generation or primary PTY before watcher startup', () => {
    const tab = state.tabsByWorktree[WORKTREE_ID][0]
    const requested = planParkedTerminalTabWatcherCoverage(WORKTREE_ID, tab)
    state.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, ptyId: SECOND_PTY_ID, generation: 2 }]

    const [acknowledgement] = syncParkedTerminalTabWatchersWithAcknowledgements({
      worktreeId: WORKTREE_ID,
      tabs: [tab],
      parkedTabIds: new Set([TAB_ID]),
      coveragePlansByTabId: new Map([[TAB_ID, requested]])
    })

    expect(acknowledgement).toMatchObject({ status: 'failed', reason: 'material-changed' })
    expect(watcherMock.starts).toEqual([])
  })

  it('keeps force-parking explicitly best-effort for an uncovered plan', () => {
    const tab = state.tabsByWorktree[WORKTREE_ID][0]
    const plan = planParkedTerminalTabWatcherCoverage(WORKTREE_ID, tab, {
      isPtyEligible: () => false
    })

    const [acknowledgement] = syncParkedTerminalTabWatchersWithAcknowledgements({
      worktreeId: WORKTREE_ID,
      tabs: [tab],
      parkedTabIds: new Set([TAB_ID]),
      coveragePlansByTabId: new Map([[TAB_ID, plan]]),
      forcedTabIds: new Set([TAB_ID])
    })

    expect(plan.status).toBe('blocked')
    expect(acknowledgement).toMatchObject({
      status: 'forced',
      materialKey: plan.materialKey,
      watchedPtyIds: [FIRST_PTY_ID, SECOND_PTY_ID]
    })
  })
})
