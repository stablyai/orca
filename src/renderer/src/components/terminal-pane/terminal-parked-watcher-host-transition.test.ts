import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalParkedWatcherSyncAcknowledgement } from './terminal-park-episode-lease'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type ExitCallback = (code: number, context: { hadPrimary: boolean }) => void

const transport = vi.hoisted(() => ({
  dataHandlers: new Map<string, (data: string) => void>(),
  dataSidecars: new Map<string, Set<(data: string) => void>>(),
  exitSidecars: new Map<string, Set<ExitCallback>>(),
  setHiddenRendererPty: vi.fn(),
  setPtyDeliveryInterest: vi.fn(),
  closeTerminalTab: vi.fn(),
  discardPreHandlerPtyState: vi.fn(),
  clearPreHandlerPtyData: vi.fn(),
  drainPreHandlerPtyData: vi.fn(),
  dispatchNotification: vi.fn()
}))

vi.mock('./pty-dispatcher', () => ({
  ensurePtyDispatcher: vi.fn(),
  ptyDataHandlers: transport.dataHandlers,
  ptyDataSidecars: transport.dataSidecars,
  subscribeToPtyExit: (ptyId: string, callback: ExitCallback) => {
    const callbacks = transport.exitSidecars.get(ptyId) ?? new Set<ExitCallback>()
    callbacks.add(callback)
    transport.exitSidecars.set(ptyId, callbacks)
    return () => {
      const current = transport.exitSidecars.get(ptyId)
      current?.delete(callback)
      if (current?.size === 0) {
        transport.exitSidecars.delete(ptyId)
      }
    }
  }
}))

vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: transport.discardPreHandlerPtyState,
  clearPreHandlerPtyData: transport.clearPreHandlerPtyData,
  drainPreHandlerPtyData: transport.drainPreHandlerPtyData
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: transport.closeTerminalTab
}))

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification: transport.dispatchNotification
}))

vi.mock('./parked-terminal-command-status', () => ({
  createParkedTerminalCommandStatusPolicy: () => ({
    onCommandFinished: vi.fn(),
    onCommandCodeWorking: vi.fn(),
    onCommandCodeDone: vi.fn(),
    dispose: vi.fn()
  }),
  readInFlightCommandCodeTurn: () => null
}))

vi.mock('@/lib/terminal-theme', () => ({ getSystemPrefersDark: () => true }))
vi.mock('./terminal-freeze-breadcrumbs', () => ({ recordTerminalFreezeBreadcrumb: vi.fn() }))

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; generation: number }[]>
  terminalLayoutsByTabId: Record<string, object>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: {
    terminalMainSideEffectAuthority: boolean
    terminalHiddenDeliveryGate: boolean
    terminalSshViewParking: boolean
    notifications: { enabled: boolean }
  }
  runtimeStatusByEnvironmentId: Map<string, never>
  agentStatusByPaneKey: Record<string, never>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
}

let storeState: MockStoreState

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  captureParkedTerminalPaneCandidates,
  getParkedTerminalWatcherTabIds,
  planParkedTerminalTabWatcherCoverage,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchersWithAcknowledgements
} from './terminal-parked-tab-watchers'
import { parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import {
  _dispatchTerminalSideEffectBatchForTest,
  _resetTerminalSideEffectFactConsumersForTest
} from './terminal-side-effect-facts-handler'
import { _resetPtyRendererDeliveryClaimsForTest } from './pty-renderer-delivery-claims'

type Host = 'split' | 'legacy'
type WatcherMode = 'bytes' | 'hidden-facts'

function createStoreState(mode: WatcherMode): MockStoreState {
  return {
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: TAB_ID, ptyId: PTY_ID, generation: 1 }]
    },
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    settings: {
      terminalMainSideEffectAuthority: mode === 'hidden-facts',
      terminalHiddenDeliveryGate: true,
      terminalSshViewParking: true,
      notifications: { enabled: false }
    },
    runtimeStatusByEnvironmentId: new Map<string, never>(),
    agentStatusByPaneKey: {},
    clearRuntimePaneTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    clearTabLaunchAgent: vi.fn(),
    setTabLayout: vi.fn()
  }
}

function syncFromHost(_host: Host): TerminalParkedWatcherSyncAcknowledgement {
  const tab = storeState.tabsByWorktree[WORKTREE_ID][0]
  const plan = planParkedTerminalTabWatcherCoverage(WORKTREE_ID, tab)
  const [acknowledgement] = syncParkedTerminalTabWatchersWithAcknowledgements({
    worktreeId: WORKTREE_ID,
    tabs: [tab],
    parkedTabIds: new Set([TAB_ID]),
    coveragePlansByTabId: new Map([[TAB_ID, plan]]),
    restoreTitleOnStartTabIds: new Set([TAB_ID])
  })
  return acknowledgement
}

function emitData(data: string): void {
  for (const callback of Array.from(transport.dataSidecars.get(PTY_ID) ?? [])) {
    callback(data)
  }
}

function emitExit(): void {
  const callbacks = Array.from(transport.exitSidecars.get(PTY_ID) ?? [])
  transport.exitSidecars.delete(PTY_ID)
  for (const callback of callbacks) {
    callback(0, { hadPrimary: false })
  }
}

describe('parked watcher split and legacy host transitions', () => {
  const originalWindow = (globalThis as { window?: Window }).window

  beforeEach(async () => {
    vi.useFakeTimers()
    ;(globalThis as { window: Window }).window = {
      ...originalWindow,
      api: {
        pty: {
          setHiddenRendererPty: transport.setHiddenRendererPty,
          setPtyDeliveryInterest: transport.setPtyDeliveryInterest,
          onSideEffect: vi.fn(() => () => {}),
          write: vi.fn()
        }
      }
    } as unknown as Window
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], async () => [
      { id: PTY_ID, authoritative: true }
    ])
  })

  afterEach(() => {
    pruneParkedTerminalWatchers(new Set())
    _resetTerminalSideEffectFactConsumersForTest()
    _resetPtyRendererDeliveryClaimsForTest()
    clearTerminalProviderSnapshotCapabilities()
    transport.dataHandlers.clear()
    transport.dataSidecars.clear()
    transport.exitSidecars.clear()
    vi.clearAllMocks()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: Window }).window = originalWindow
    } else {
      delete (globalThis as { window?: Window }).window
    }
  })

  it.each([
    ['split', 'legacy', 'bytes'],
    ['legacy', 'split', 'bytes'],
    ['split', 'legacy', 'hidden-facts'],
    ['legacy', 'split', 'hidden-facts']
  ] as const)('keeps one owner across %s to %s in %s mode', async (first, second, mode) => {
    storeState = createStoreState(mode)
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 1, [
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }
    ])

    const firstAcknowledgement = syncFromHost(first)
    const secondAcknowledgement = syncFromHost(second)

    expect(firstAcknowledgement).toMatchObject({
      status: 'covering',
      tabId: TAB_ID,
      watchedPtyIds: [PTY_ID]
    })
    expect(secondAcknowledgement).toEqual(firstAcknowledgement)
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
    expect(parkedWatchersByTabId.get(TAB_ID)?.disposersByPtyId.size).toBe(1)
    expect(transport.exitSidecars.get(PTY_ID)?.size).toBe(1)

    if (mode === 'bytes') {
      expect(transport.dataSidecars.get(PTY_ID)?.size).toBe(2)
      expect(transport.setPtyDeliveryInterest.mock.calls).toEqual([[PTY_ID, true]])
      expect(transport.setHiddenRendererPty).not.toHaveBeenCalled()
      emitData('\x07')
      vi.advanceTimersByTime(0)
    } else {
      expect(transport.dataSidecars.get(PTY_ID)).toBeUndefined()
      expect(transport.setPtyDeliveryInterest).not.toHaveBeenCalled()
      expect(transport.setHiddenRendererPty.mock.calls).toEqual([[PTY_ID, true]])
      _dispatchTerminalSideEffectBatchForTest({
        ptyId: PTY_ID,
        seq: 1,
        facts: [{ kind: 'bell' }]
      })
    }
    expect(storeState.markWorktreeUnread).toHaveBeenCalledOnce()
    expect(storeState.markTerminalTabUnread).toHaveBeenCalledOnce()

    emitExit()

    expect(transport.closeTerminalTab).toHaveBeenCalledOnce()
    expect(transport.exitSidecars.get(PTY_ID)).toBeUndefined()
    if (mode === 'bytes') {
      expect(transport.setPtyDeliveryInterest.mock.calls).toEqual([
        [PTY_ID, true],
        [PTY_ID, false]
      ])
    } else {
      expect(transport.setHiddenRendererPty.mock.calls).toEqual([
        [PTY_ID, true],
        [PTY_ID, false]
      ])
    }
  })
})
