import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sidecars preserve untouched sole-newborn tabs on exit using captured plain values, never retained session references.

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const startedWatcherDisposers: ReturnType<typeof vi.fn>[] = []
vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: () => {
    const dispose = vi.fn()
    startedWatcherDisposers.push(dispose)
    return dispose
  }
}))

type ExitCallback = (code: number, context: { hadPrimary: boolean }) => void
const exitCallbacksByPtyId = new Map<string, ExitCallback>()
vi.mock('../../pty-transport/delivery/pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: ExitCallback) => {
    exitCallbacksByPtyId.set(ptyId, callback)
    return vi.fn()
  }
}))

const consumePreHandlerPtyState = vi.fn()
const discardPreHandlerPtyState = vi.fn()
vi.mock('../../pty-transport/delivery/pty-pre-handler-buffer', () => ({
  consumePreHandlerPtyState: (ptyId: string) => consumePreHandlerPtyState(ptyId),
  discardPreHandlerPtyState: (ptyId: string) => discardPreHandlerPtyState(ptyId),
  hasPreHandlerPtyExit: () => false
}))

const closeTerminalTab = vi.fn()
vi.mock('../../../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (tabId: string, options?: unknown) => closeTerminalTab(tabId, options)
}))

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  terminalLayoutsByTabId: Record<string, unknown>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  isPtyShutdownPending: ReturnType<typeof vi.fn>
  suppressedPtyExitIds: Record<string, true>
}
let mockStoreState: MockStoreState
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import { startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import type {
  ParkedTabWatcherEntry,
  ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

function startWatchers(panes: ParkedTerminalPaneCapture[]): ParkedTabWatcherEntry {
  const entry: ParkedTabWatcherEntry = {
    worktreeId: WORKTREE_ID,
    tabPtyId: PTY_ID,
    paneIdByPtyId: new Map(),
    disposersByPtyId: new Map()
  }
  const tab = { id: TAB_ID, ptyId: PTY_ID }
  for (const pane of panes) {
    startParkedPtyWatcher({
      worktreeId: WORKTREE_ID,
      tab,
      pane,
      entry,
      restoreTitleOnRegister: false,
      restorePolicy: {}
    })
  }
  return entry
}

const soleNewbornPane: ParkedTerminalPaneCapture = {
  ptyId: PTY_ID,
  paneId: 1,
  leafId: LEAF_ID,
  drivesTabTitle: true,
  untouchedFreshSpawn: true
}

describe('sole-newborn parked exits (sole-owner sidecar)', () => {
  beforeEach(() => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn(),
      isPtyShutdownPending: vi.fn(() => false),
      suppressedPtyExitIds: {}
    }
  })

  afterEach(() => {
    startedWatcherDisposers.length = 0
    exitCallbacksByPtyId.clear()
    vi.clearAllMocks()
  })

  it('becomes the sole-newborn guard after a split sibling already collapsed', () => {
    const entry = startWatchers([
      soleNewbornPane,
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    exitCallbacksByPtyId.get(SECOND_PTY_ID)?.(0, { hadPrimary: false })
    expect(entry.disposersByPtyId.size).toBe(1)

    exitCallbacksByPtyId.get(PTY_ID)?.(1, { hadPrimary: false })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
  })
})
