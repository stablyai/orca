import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why this file: detach drops the session-bound primary exit observer (it pinned
// the disposed pane's xterm buffers), so the parked watcher sidecar is the sole
// owner of a parked PTY's exit. Orchestrated sleep/shutdown exits must keep the
// tab and the layout the wake path restores.

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

const discardPreHandlerPtyState = vi.fn()
vi.mock('./pty-pre-handler-buffer', () => ({
  consumePreHandlerPtyState: vi.fn(),
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

import {
  consumeCommittedPtyShutdownExit,
  markCommittedPtyShutdowns
} from './pty-shutdown-exit-deferral'
import { startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import type { ParkedTabWatcherEntry } from './terminal-parked-watcher-registry'

function startSplitWatchers(): ParkedTabWatcherEntry {
  const entry: ParkedTabWatcherEntry = {
    worktreeId: WORKTREE_ID,
    tabPtyId: PTY_ID,
    paneIdByPtyId: new Map(),
    disposersByPtyId: new Map()
  }
  const tab = { id: TAB_ID, ptyId: PTY_ID }
  for (const pane of [
    { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
    { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
  ]) {
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

describe('sleep-preserved parked exits (sole-owner sidecar)', () => {
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
    // Drain any committed marker a test armed but did not consume.
    consumeCommittedPtyShutdownExit(PTY_ID, null)
  })

  it.each([
    ['pending renderer shutdown', () => mockStoreState.isPtyShutdownPending.mockReturnValue(true)],
    ['suppressed intentional restart', () => (mockStoreState.suppressedPtyExitIds[PTY_ID] = true)],
    ['committed sleep marker', () => markCommittedPtyShutdowns([PTY_ID])]
  ] as const)('keeps the tab and layout on a %s exit', (_marker, arm) => {
    const entry = startSplitWatchers()
    arm()

    exitCallbacksByPtyId.get(PTY_ID)?.(0, { hadPrimary: false })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    // The buffered exit stays as the restart tombstone.
    expect(discardPreHandlerPtyState).not.toHaveBeenCalled()
    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
    expect(startedWatcherDisposers[0]).toHaveBeenCalled()
    expect(startedWatcherDisposers[1]).not.toHaveBeenCalled()
    expect(entry.disposersByPtyId.has(PTY_ID)).toBe(false)
    // The one-shot committed marker is consumed by the guard, never leaked.
    expect(consumeCommittedPtyShutdownExit(PTY_ID, null)).toBe(false)
  })

  it('leaves the committed marker to the primary when one handled the exit', () => {
    startSplitWatchers()
    markCommittedPtyShutdowns([PTY_ID])

    exitCallbacksByPtyId.get(PTY_ID)?.(0, { hadPrimary: true })

    // hadPrimary skips the guard entirely: marker untouched, watcher disposed.
    expect(consumeCommittedPtyShutdownExit(PTY_ID, null)).toBe(true)
    expect(startedWatcherDisposers[0]).toHaveBeenCalled()
  })

  it('still collapses the dead leaf on an ordinary parked split exit', () => {
    startSplitWatchers()

    exitCallbacksByPtyId.get(SECOND_PTY_ID)?.(0, { hadPrimary: false })

    // No sleep marker: the pre-fix disposition is untouched.
    expect(discardPreHandlerPtyState).toHaveBeenCalledWith(SECOND_PTY_ID)
  })

  it('still closes the tab on an ordinary exit of the last parked pane', () => {
    const entry = startSplitWatchers()
    exitCallbacksByPtyId.get(SECOND_PTY_ID)?.(0, { hadPrimary: false })
    expect(entry.disposersByPtyId.size).toBe(1)

    exitCallbacksByPtyId.get(PTY_ID)?.(0, { hadPrimary: false })

    // The unarmed committed-marker probe in the guard must not block the close.
    expect(closeTerminalTab).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({
        hostCloseReason: 'pty-exit',
        lifecyclePtyId: PTY_ID
      })
    )
  })
})
