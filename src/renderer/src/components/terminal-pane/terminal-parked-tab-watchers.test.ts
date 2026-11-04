import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const WORKTREE_ID = 'repo::/worktree'
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
  discardPreHandlerPtyState: (ptyId: string) => consumePreHandlerPtyState(ptyId),
  hasPreHandlerPtyExit: (ptyId: string) => unownedExitPtyIds.has(ptyId)
}))

/** PTYs whose exit was delivered with no owning handler — the park handoff gap. */
const unownedExitPtyIds = new Set<string>()

type CloseTerminalTabOptions = {
  captureRecentlyClosed?: boolean
  hostCloseReason?: string
  lifecyclePtyId?: string
  onClosed?: () => void
  onCancel?: () => void
}
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
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: { capabilities?: string[] } | null; checkedAt: number }
  >
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markUnverifiedPtyLoss: ReturnType<typeof vi.fn>
  isPtyShutdownPending: ReturnType<typeof vi.fn>
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
  canWatcherCoverParkedTerminalTab,
  captureParkedTerminalPaneCandidates,
  disposeParkedTerminalWatchersForPtyIds,
  collectParkedTerminalWatcherPtyIds,
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
  beforeEach(async () => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      settings: null,
      runtimeStatusByEnvironmentId: new Map(),
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn(),
      markUnverifiedPtyLoss: vi.fn(),
      isPtyShutdownPending: vi.fn(() => false),
      suppressedPtyExitIds: {}
    }
    ;(globalThis as { window?: unknown }).window = { api: { pty: { write: ptyWrite } } }
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID, SECOND_PTY_ID], async (ids) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
  })

  afterEach(() => {
    unownedExitPtyIds.clear()
    // Prune persistent module registries so each suite starts without parked watchers.
    pruneParkedTerminalWatchers(new Set())
    startedWatchers.length = 0
    exitSubscriptions.length = 0
    vi.clearAllMocks()
    clearTerminalProviderSnapshotCapabilities()
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('never starts a watcher for a PTY that exited into the park handoff gap', () => {
    // An exit in the primary/sidecar handoff gap must not become a live parked claim that republishes the dead leaf (STA-2854).
    unownedExitPtyIds.add(PTY_ID)
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked({ tabs: [{ id: TAB_ID, ptyId: PTY_ID }] })

    expect(startParkedTerminalByteWatcher).not.toHaveBeenCalled()
    expect(collectParkedTerminalWatcherPtyIds().has(PTY_ID)).toBe(false)
    // Clear stranded working titles or they pin worktree status indefinitely.
    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
  })

  it('collapses a dead split leaf even when a concurrent primary handler also observed the exit', () => {
    // Coexisting eager/reveal primary handlers do not collapse parked layout; sidecar must still remove dead split leaves.
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

    const exited = exitSubscriptions.find((entry) => entry.ptyId === SECOND_PTY_ID)
    exited?.callback(0, { hadPrimary: true })

    expect(mockStoreState.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
    })
    expect(startedWatchers[1].dispose).toHaveBeenCalledTimes(1)
    expect(startedWatchers[0].dispose).not.toHaveBeenCalled()
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('consumes the exit and drops the parked entry after the last-watcher close resolves', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })

    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
    const options = closeTerminalTab.mock.calls[0]?.[1] as CloseTerminalTabOptions
    expect(options.captureRecentlyClosed).toBe(false)
    // Carry pty-exit intent so paired hosts can reject live-PTY echoes without bypassing the local pinned guard.
    expect(options.hostCloseReason).toBe('pty-exit')
    expect(options.lifecyclePtyId).toBe(PTY_ID)
    options.onClosed?.()

    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('preserves a parked tab when the host reports an unverified PTY loss', () => {
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    syncParked()

    exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(-1, { hadPrimary: false })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(mockStoreState.markUnverifiedPtyLoss).toHaveBeenCalledWith(TAB_ID)
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  it('preserves every leaf and the parked registry across split unverified losses', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    syncParked()
    const layout = {
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
    }
    mockStoreState.terminalLayoutsByTabId[TAB_ID] = layout

    exitSubscriptions
      .find((entry) => entry.ptyId === PTY_ID)
      ?.callback(-1, {
        hadPrimary: false
      })

    expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(startedWatchers[1].dispose).not.toHaveBeenCalled()
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])

    exitSubscriptions
      .find((entry) => entry.ptyId === SECOND_PTY_ID)
      ?.callback(-1, {
        hadPrimary: false
      })

    expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    expect(startedWatchers[1].dispose).toHaveBeenCalledTimes(1)
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

    // A queued pinned close may remove the tab before the autonomous exit request resolves.
    syncParked({ tabs: [] })

    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(getParkedTerminalWatcherTabIds()).toEqual([])
  })

  // Eager/reveal primary handlers can still overlap a parked sidecar after detach drops the session observer.
  it('does not queue a second close when a concurrent primary handled the parked exit', () => {
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
    // Keep the empty entry so sleep cannot restart watchers against stale PTY IDs before wake.
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

  describe('shouldDeferParkedPtyExitTabClose', () => {
    const closeTab = vi.fn()

    // Mirrors both hosts' onPtyExit wiring: the guard runs before closeTab.
    function hostOnPtyExit(tabId: string, ptyId: string): void {
      if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTab(tabId)
    }

    it('collapses the exited leaf out of the stored layout when deferring', () => {
      // Remove exited leaf/binding before reveal or the daemon recreates its session as a new shell.
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

    it('collapses a dead leaf then closes when the last parked split leaf exits', () => {
      // Parked exits reach only sidecars; they must collapse layout themselves to prevent leaf resurrection.
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
    it('rejects ordinary parking for a preserved daemon with a lossy snapshot', async () => {
      clearTerminalProviderSnapshotCapabilities()
      await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], async () => [
        { id: PTY_ID, authoritative: false }
      ])
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])

      expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(
        false
      )
    })

    it('rejects a capture containing a PTY without snapshot backing', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        // Why foreign-worktree id: minted under another worktree, never restorable.
        { ptyId: 'other::wt@@session-9', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
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
