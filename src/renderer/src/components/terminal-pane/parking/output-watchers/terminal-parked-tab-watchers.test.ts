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

vi.mock('../../pty-transport/delivery/pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: (code: number) => void) =>
    subscribeToPtyExit(ptyId, callback)
}))

const consumePreHandlerPtyState = vi.fn()
vi.mock('../../pty-transport/delivery/pty-pre-handler-buffer', () => ({
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
vi.mock('../../../terminal/terminal-tab-actions', () => ({
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
  sleepingAgentSessionsByPaneKey: Record<string, { tabId?: string }>
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

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../../../terminal/terminal-provider-snapshot-capability'
import { probeTerminalProviderGoneSessions } from '../../../terminal/terminal-provider-gone-sessions'
import './terminal-parked-tab-watchers'
import { canWatcherCoverParkedTerminalTab } from './parked-terminal-tab-coverage'
import {
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers
} from './terminal-parked-watcher-registry'

const ptyWrite = vi.fn()
const originalWindow = (globalThis as { window?: unknown }).window

function capturePanes(
  panes: { ptyId: string | null; paneId: number; leafId: string; drivesTabTitle: boolean }[],
  args?: { tabId?: string; worktreeId?: string }
): void {
  captureParkedTerminalPaneCandidates(args?.tabId ?? TAB_ID, args?.worktreeId ?? WORKTREE_ID, panes)
}

describe('terminal-parked-tab-watchers', () => {
  beforeEach(async () => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      sleepingAgentSessionsByPaneKey: {},
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

  it('keeps a split tab mounted when only some pane sessions are gone', async () => {
    await probeTerminalProviderGoneSessions([PTY_ID], async () => [PTY_ID])
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])

    expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(false)
  })

  it('keeps a gone agent tab mounted so its resume path is unchanged', async () => {
    await probeTerminalProviderGoneSessions([PTY_ID], async () => [PTY_ID])
    mockStoreState.tabsByWorktree[WORKTREE_ID] = [
      { id: TAB_ID, ptyId: PTY_ID, launchAgent: 'claude' }
    ]
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])

    expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, { id: TAB_ID, ptyId: PTY_ID })).toBe(false)
  })
})
