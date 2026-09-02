import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why this file: the parked sidecar owns a parked PTY's exit, so it must mirror
// the session observer's sole-newborn guard (pty-exit-hibernate): a sole
// fresh-spawned pane nobody ever typed into keeps its tab on exit. The fact
// travels as the plain-value `untouchedFreshSpawn` capture flag — never a
// session reference.

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
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: ExitCallback) => {
    exitCallbacksByPtyId.set(ptyId, callback)
    return vi.fn()
  }
}))

const consumePreHandlerPtyState = vi.fn()
const discardPreHandlerPtyState = vi.fn()
vi.mock('./pty-pre-handler-buffer', () => ({
  consumePreHandlerPtyState: (ptyId: string) => consumePreHandlerPtyState(ptyId),
  discardPreHandlerPtyState: (ptyId: string) => discardPreHandlerPtyState(ptyId),
  hasPreHandlerPtyExit: () => false
}))

const closeTerminalTab = vi.fn()
vi.mock('../terminal/terminal-tab-actions', () => ({
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
vi.mock('@/store', () => ({
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

  it('keeps the tab when the sole untouched fresh-spawn pane exits while parked', () => {
    const entry = startWatchers([soleNewbornPane])

    exitCallbacksByPtyId.get(PTY_ID)?.(1, { hadPrimary: false })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
    expect(startedWatcherDisposers[0]).toHaveBeenCalled()
    expect(entry.disposersByPtyId.has(PTY_ID)).toBe(false)
    // The exit is consumed (pre-fix primary parity), never left as a buffered
    // tombstone — a tombstone would close the tab at reveal via exitedBeforeAttach.
    expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(discardPreHandlerPtyState).not.toHaveBeenCalled()
    // The pane-id slot stays, so a watcher sync never re-registers the dead PTY.
    expect(entry.paneIdByPtyId.get(PTY_ID)).toBe(1)
  })

  it.each([
    ['no fresh-spawn/never-typed capture', {}],
    ['an explicit non-newborn capture', { untouchedFreshSpawn: false }]
  ] as const)('still closes the tab with %s', (_case, flag) => {
    const { untouchedFreshSpawn: _dropped, ...basePane } = soleNewbornPane
    startWatchers([{ ...basePane, ...flag }])

    exitCallbacksByPtyId.get(PTY_ID)?.(1, { hadPrimary: false })

    expect(closeTerminalTab).toHaveBeenCalledWith(TAB_ID, expect.anything())
    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
  })

  it('does not extend the guard to a newborn split sibling — its leaf collapses as today', () => {
    startWatchers([
      soleNewbornPane,
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])

    exitCallbacksByPtyId.get(PTY_ID)?.(1, { hadPrimary: false })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    // Split-sibling branch: pre-handler state discarded, not consumed-for-parity.
    expect(discardPreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
  })

  it('leaves disposition to the primary when a mounted pane handled the exit', () => {
    const entry = startWatchers([soleNewbornPane])

    exitCallbacksByPtyId.get(PTY_ID)?.(1, { hadPrimary: true })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(consumePreHandlerPtyState).not.toHaveBeenCalled()
    expect(startedWatcherDisposers[0]).toHaveBeenCalled()
    expect(entry.disposersByPtyId.has(PTY_ID)).toBe(false)
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
