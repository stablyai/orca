import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other-worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type StartedWatcher = {
  options: ParkedTerminalByteWatcherOptions
  dispose: ReturnType<typeof vi.fn>
}

const startedWatchers: StartedWatcher[] = []
const startParkedTerminalByteWatcher = vi.fn((options: ParkedTerminalByteWatcherOptions) => {
  const dispose = vi.fn()
  startedWatchers.push({ options, dispose })
  return dispose
})

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: (options: ParkedTerminalByteWatcherOptions) =>
    startParkedTerminalByteWatcher(options)
}))

type ExitSubscription = {
  ptyId: string
  callback: (code: number, context: { hadPrimary: boolean }) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const exitSubscriptions: ExitSubscription[] = []
const subscribeToPtyExit = vi.fn(
  (ptyId: string, callback: (code: number, context: { hadPrimary: boolean }) => void) => {
    const unsubscribe = vi.fn()
    exitSubscriptions.push({ ptyId, callback, unsubscribe })
    return unsubscribe
  }
)

vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: (code: number) => void) =>
    subscribeToPtyExit(ptyId, callback)
}))

const consumePreHandlerPtyState = vi.fn()
vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: (ptyId: string) => consumePreHandlerPtyState(ptyId)
}))

type CloseTerminalTabOptions = { onClosed?: () => void; onCancel?: () => void }
const closeTerminalTab = vi.fn()
vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (tabId: string, options?: CloseTerminalTabOptions) =>
    closeTerminalTab(tabId, options)
}))

type MockStoreState = {
  tabsByWorktree: Record<
    string,
    { id: string; launchAgent?: 'claude' | 'codex'; ptyId: string | null }[]
  >
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
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  canWatcherCoverParkedTerminalTab,
  captureParkedTerminalPaneCandidates,
  disposeParkedTerminalWatchersForPtyIds,
  disposeParkedTerminalWatchersForWorktree,
  fallbackParkedPaneCandidates,
  getParkedTerminalWatcherTabIds,
  pruneParkedTerminalWatchers,
  shouldDeferParkedPtyExitTabClose,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'

const ptyWrite = vi.fn()
const originalWindow = (globalThis as { window?: unknown }).window

function capturePanes(
  panes: { ptyId: string | null; paneId: number; leafId: string; drivesTabTitle: boolean }[],
  args?: { tabId?: string; worktreeId?: string }
): void {
  captureParkedTerminalPaneCandidates(args?.tabId ?? TAB_ID, args?.worktreeId ?? WORKTREE_ID, panes)
}

function syncParked(args?: {
  worktreeId?: string
  tabs?: { id: string; ptyId: string | null }[]
  parkedTabIds?: Iterable<string>
  restoreTitleOnStartTabIds?: Iterable<string>
}): void {
  syncParkedTerminalTabWatchers({
    worktreeId: args?.worktreeId ?? WORKTREE_ID,
    tabs: args?.tabs ?? [{ id: TAB_ID, ptyId: PTY_ID }],
    parkedTabIds: new Set(args?.parkedTabIds ?? [TAB_ID]),
    ...(args?.restoreTitleOnStartTabIds
      ? { restoreTitleOnStartTabIds: new Set(args.restoreTitleOnStartTabIds) }
      : {})
  })
}

describe('terminal-parked-tab-watchers', () => {
  beforeEach(() => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn()
    }
    ;(globalThis as { window?: unknown }).window = { api: { pty: { write: ptyWrite } } }
  })

  afterEach(() => {
    // Module-level registries persist across tests; clear them through the
    // public prune path so each test starts from an empty parked state.
    pruneParkedTerminalWatchers(new Set())
    startedWatchers.length = 0
    exitSubscriptions.length = 0
    vi.clearAllMocks()
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('starts one watcher per captured snapshot-backed PTY with the captured pane identity', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()

    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(2)
    expect(startedWatchers[0].options).toMatchObject({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: 1,
      drivesTabTitle: true
    })
    expect(startedWatchers[1].options).toMatchObject({
      ptyId: SECOND_PTY_ID,
      paneId: 2,
      drivesTabTitle: false
    })
    expect(startedWatchers[0].options.restoreTitleOnRegister).toBeUndefined()
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('requests a title snapshot when a mount-restricted tab starts its watcher', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked({ restoreTitleOnStartTabIds: [TAB_ID] })

    expect(startedWatchers[0].options.restoreTitleOnRegister).toBe(true)
  })

  it('routes watcher sendInput to window.api.pty.write for the watched PTY', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    startedWatchers[0].options.sendInput('\x1b[?2031;1$y')
    expect(ptyWrite).toHaveBeenCalledWith(PTY_ID, '\x1b[?2031;1$y')
  })

  it('skips legacy non-UUID leaf ids instead of throwing in makePaneKey', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: 'legacy-leaf-1', drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()

    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(1)
    expect(startedWatchers[0].options).toMatchObject({ ptyId: SECOND_PTY_ID })
  })

  it('never starts watchers for remote-runtime or SSH PTYs', () => {
    capturePanes([
      { ptyId: 'remote:env-1@@terminal-1', paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'ssh:conn-1@@pty-1', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked({ tabs: [{ id: TAB_ID, ptyId: null }] })

    expect(startParkedTerminalByteWatcher).not.toHaveBeenCalled()
    // Why: the tab is still tracked as parked so debug introspection
    // (window.__terminalParkingDebug) reflects every parked tab.
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('keeps existing watchers across repeated syncs of the same parked state', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    syncParked()

    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(1)
    expect(startedWatchers[0].dispose).not.toHaveBeenCalled()
  })

  it('disposes the watcher and exit subscription when the tab unparks', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    syncParked({ parkedTabIds: [] })

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(exitSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('disposes the watcher when the tab closes while parked', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    syncParked({ tabs: [], parkedTabIds: [TAB_ID] })

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('disposes a PTY watcher when that PTY exits while parked', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()

    const exited = exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)
    exited?.callback(0, { hadPrimary: false })

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(startedWatchers[1].dispose).not.toHaveBeenCalled()
    // The tab itself is still parked, only the exited PTY's watcher is gone.
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('seeds each watcher with the pane slot last known runtime title', () => {
    mockStoreState.runtimePaneTitlesByTabId = { [TAB_ID]: { 1: '⠋ Build feature' } }
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()

    expect(startedWatchers[0].options.initialTitle).toBe('⠋ Build feature')
    expect(startedWatchers[1].options.initialTitle).toBeUndefined()
  })

  it('consumes the exit and drops the parked entry after the last-watcher close resolves', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })

    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
    const options = closeTerminalTab.mock.calls[0]?.[1] as CloseTerminalTabOptions
    options.onClosed?.()

    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('retains the buffered exit and empty registry entry when pinned close is cancelled', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })
    const options = closeTerminalTab.mock.calls[0]?.[1] as CloseTerminalTabOptions
    options.onCancel?.()
    syncParked({ parkedTabIds: [] })

    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])

    expect(shouldDeferParkedPtyExitTabClose(TAB_ID, PTY_ID)).toBe(true)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
    expect(shouldDeferParkedPtyExitTabClose(TAB_ID, PTY_ID)).toBe(false)
  })

  it('consumes a queued parked exit when another confirmation closes the tab first', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })

    // Why: a manual pinned close can be ahead of this autonomous exit request
    // in the confirmation queue and remove the tab before the exit resolves.
    syncParked({ tabs: [] })

    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('does not queue a second close when a retained primary handled the parked exit', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: true })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('synchronously disposes watchers for the given PTY ids without unparking the tab', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()

    disposeParkedTerminalWatchersForPtyIds([PTY_ID])

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(exitSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(startedWatchers[1].dispose).not.toHaveBeenCalled()
    // Why: the entry survives so a sleeping parked tab cannot restart a
    // watcher against its stale PTY ids before wake re-mints them.
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
    syncParked()
    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(2)
  })

  it('restarts watchers from store layout when the tab PTY was re-minted', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    const remintedPtyId = `${WORKTREE_ID}@@session-after-wake`
    mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: remintedPtyId }
    }
    syncParked({ tabs: [{ id: TAB_ID, ptyId: remintedPtyId }] })

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(2)
    expect(startedWatchers[1].options).toMatchObject({ ptyId: remintedPtyId, leafId: LEAF_ID })
  })

  it('scopes sync disposal to the given worktree', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    const otherPtyId = `${OTHER_WORKTREE_ID}@@session-9`
    capturePanes([{ ptyId: otherPtyId, paneId: 1, leafId: SECOND_LEAF_ID, drivesTabTitle: true }], {
      tabId: 'tab-other',
      worktreeId: OTHER_WORKTREE_ID
    })
    syncParked({
      worktreeId: OTHER_WORKTREE_ID,
      tabs: [{ id: 'tab-other', ptyId: otherPtyId }],
      parkedTabIds: ['tab-other']
    })

    // Unparking everything in the other worktree must not touch this one.
    syncParked({ worktreeId: OTHER_WORKTREE_ID, tabs: [], parkedTabIds: [] })
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
    expect(startedWatchers[0].dispose).not.toHaveBeenCalled()
  })

  it('disposes all of a worktree watchers on worktree teardown and prunes deleted worktrees', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    disposeParkedTerminalWatchersForWorktree(WORKTREE_ID)
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])

    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()
    pruneParkedTerminalWatchers(new Set([OTHER_WORKTREE_ID]))
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('consumes parked state when child cleanup observes a removed worktree', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    disposeParkedTerminalWatchersForWorktree(WORKTREE_ID, {
      consumePreHandlerState: true
    })

    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  describe('shouldDeferParkedPtyExitTabClose', () => {
    const closeTab = vi.fn()

    // Mirrors both hosts' onPtyExit wiring: the guard runs before closeTab.
    function hostOnPtyExit(tabId: string, ptyId: string): void {
      if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTab(tabId)
    }

    it('defers tab close on PTY exit in a parked multi-leaf tab and clears the dead slot', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).not.toHaveBeenCalled()
      // The dead leaf's runtime-title slot cannot pin worktree status.
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
    })

    it('collapses the exited leaf out of the stored layout when deferring', () => {
      // Why (regression, ghost/resurrected pane): a deferred parked exit that
      // leaves the leaf and its binding in the stored layout reattaches on
      // reveal — the daemon re-creates the exited session id as a fresh shell.
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)

      expect(closeTab).not.toHaveBeenCalled()
      expect(mockStoreState.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      })
    })

    it('retires launch/title hints when the launch-owning parked leaf exits', () => {
      mockStoreState.tabsByWorktree = {
        [WORKTREE_ID]: [{ id: TAB_ID, launchAgent: 'codex', ptyId: PTY_ID }]
      }
      mockStoreState.runtimePaneTitlesByTabId = {
        [TAB_ID]: { 1: 'Codex', 2: 'PowerShell' }
      }
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(mockStoreState.clearTabLaunchAgent).toHaveBeenCalledWith(TAB_ID)
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, 'PowerShell')
    })

    it('keeps launch ownership when only a parked shell sibling exits', () => {
      mockStoreState.tabsByWorktree = {
        [WORKTREE_ID]: [{ id: TAB_ID, launchAgent: 'claude', ptyId: PTY_ID }]
      }
      mockStoreState.runtimePaneTitlesByTabId = { [TAB_ID]: { 1: 'Claude Code' } }
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)

      expect(mockStoreState.clearTabLaunchAgent).not.toHaveBeenCalled()
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, 'Claude Code')
    })

    it('keeps exit→closeTab parity for a parked single-leaf tab', () => {
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      syncParked()

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })

    it('keeps exit→closeTab parity when the tab is not parked', () => {
      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })

    it('collapses a dead leaf then closes when the last parked split leaf exits', () => {
      // Why: hosts' onPtyExit runs from a mounted TerminalPane, so an exit
      // that lands while parked reaches ONLY the watcher sidecar — it must run
      // the layout collapse itself or the leaf resurrects on reveal.
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      exitSubscriptions
        .find((entry) => entry.ptyId === SECOND_PTY_ID)
        ?.callback(0, { hadPrimary: false })

      expect(consumePreHandlerPtyState).toHaveBeenCalledWith(SECOND_PTY_ID)
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 2)
      expect(mockStoreState.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      })

      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })
      const options = closeTerminalTab.mock.calls[0]?.[1] as CloseTerminalTabOptions
      options.onClosed?.()
      expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    })

    it('does not touch the layout when the last parked watcher exits (tab-level close owns it)', () => {
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }

      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })

      expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    })

    it('closes the tab when the last surviving leaf of a parked split exits', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()

      // First leaf dies: deferred, then its exit sidecar drops the watcher.
      hostOnPtyExit(TAB_ID, PTY_ID)
      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })
      expect(closeTab).not.toHaveBeenCalled()

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)
      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })
  })

  describe('canWatcherCoverParkedTerminalTab', () => {
    it('rejects a tab with no unmount capture and no layout snapshot', () => {
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        false
      )
    })

    it('accepts a current capture whose panes are all snapshot-backed', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        true
      )
    })

    it('lets cold activation add stricter eligibility without changing ordinary parking', () => {
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      const providerCanSnapshotWithoutRenderer = vi.fn(() => false)

      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        true
      )
      expect(
        canWatcherCoverParkedTerminalTab(
          WORKTREE_ID,
          { id: TAB_ID, ptyId: PTY_ID },
          providerCanSnapshotWithoutRenderer
        )
      ).toBe(false)
      expect(providerCanSnapshotWithoutRenderer).toHaveBeenCalledWith(PTY_ID)
    })

    it('rejects a capture containing a legacy non-UUID leaf id', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: 'legacy-leaf-1', drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        false
      )
    })

    it('rejects a capture containing a PTY without snapshot backing', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: 'ssh:conn-1@@pty-1', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        false
      )
    })

    it('accepts layout-derived candidates when the capture is stale', () => {
      capturePanes([{ ptyId: 'old-pty', paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        true
      )
    })

    it('rejects layout-derived candidates missing a leaf PTY binding', () => {
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'row',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        false
      )
    })
  })
})

describe('fallbackParkedPaneCandidates', () => {
  it('returns nothing without a layout snapshot', () => {
    expect(
      fallbackParkedPaneCandidates(
        { id: TAB_ID, ptyId: PTY_ID },
        { terminalLayoutsByTabId: {}, runtimePaneTitlesByTabId: {} }
      )
    ).toEqual([])
  })

  it('reuses the single runtime-title slot for a single-pane tab', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: null }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 7: 'working title' } }
      } as never)
    ).toEqual([{ ptyId: PTY_ID, paneId: 7, leafId: LEAF_ID, drivesTabTitle: true }])
  })

  it('maps split leaves to layout PTYs with collision-free negative pane ids', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'row',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'a', 2: 'b' } }
      } as never)
    ).toEqual([
      { ptyId: PTY_ID, paneId: -1, leafId: LEAF_ID, drivesTabTitle: false },
      { ptyId: SECOND_PTY_ID, paneId: -2, leafId: SECOND_LEAF_ID, drivesTabTitle: true }
    ])
  })
})
