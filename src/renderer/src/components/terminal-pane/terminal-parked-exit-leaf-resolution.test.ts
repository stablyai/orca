import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other-worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const REPLACEMENT_PTY_ID = `${WORKTREE_ID}@@replacement`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; generation?: number }[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
}

let state: MockStoreState

type ExitCallback = (code: number, context: { hadPrimary: boolean }) => void
const watcherTransport = vi.hoisted(() => ({
  exitCallbacks: new Map<string, ExitCallback>(),
  discardPreHandlerPtyState: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: vi.fn(() => vi.fn())
}))
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: ExitCallback) => {
    watcherTransport.exitCallbacks.set(ptyId, callback)
    return vi.fn()
  }
}))
vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: watcherTransport.discardPreHandlerPtyState
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))

import { collapseParkedExitedLeaf, startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import {
  captureParkedTerminalPaneCandidates,
  capturedPanesByTabId,
  parkedWatchersByTabId
} from './terminal-parked-watcher-registry'

function splitLayout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SECOND_LEAF_ID }
    },
    activeLeafId: SECOND_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function capture(worktreeId: string, generation: number): void {
  captureParkedTerminalPaneCandidates(TAB_ID, worktreeId, generation, [
    { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
    { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
  ])
}

function startFirstLeafWatcher(): void {
  const entry = parkedWatchersByTabId.get(TAB_ID)
  if (!entry) {
    throw new Error('missing parked watcher entry')
  }
  entry.disposersByPtyId.set(SECOND_PTY_ID, vi.fn())
  startParkedPtyWatcher({
    worktreeId: WORKTREE_ID,
    tab: { id: TAB_ID, ptyId: PTY_ID, generation: 1 },
    pane: { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
    entry,
    restoreTitleOnRegister: false,
    restorePolicy: { sshParkingEnabled: true }
  })
}

describe('parked exit leaf resolution', () => {
  beforeEach(() => {
    state = {
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: TAB_ID, ptyId: PTY_ID, generation: 1 }]
      },
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Agent', 2: 'Shell' } },
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn()
    }
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: WORKTREE_ID,
      tabPtyId: PTY_ID,
      paneIdByPtyId: new Map([
        [PTY_ID, 1],
        [SECOND_PTY_ID, 2]
      ]),
      disposersByPtyId: new Map()
    })
  })

  afterEach(() => {
    capturedPanesByTabId.delete(TAB_ID)
    parkedWatchersByTabId.delete(TAB_ID)
    watcherTransport.exitCallbacks.clear()
    vi.clearAllMocks()
  })

  it('does not detach a replacement occupant through the watcher leaf fallback', () => {
    startFirstLeafWatcher()
    captureParkedTerminalPaneCandidates(TAB_ID, OTHER_WORKTREE_ID, 9, [
      { ptyId: SECOND_PTY_ID, paneId: 8, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: PTY_ID, paneId: 9, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [LEAF_ID]: REPLACEMENT_PTY_ID,
      [SECOND_LEAF_ID]: SECOND_PTY_ID
    })

    watcherTransport.exitCallbacks.get(PTY_ID)?.(0, { hadPrimary: false })

    expect(state.setTabLayout).not.toHaveBeenCalled()
  })

  it('uses a current watcher leaf when the layout leaves it unbound', () => {
    startFirstLeafWatcher()
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [SECOND_LEAF_ID]: SECOND_PTY_ID
    })

    watcherTransport.exitCallbacks.get(PTY_ID)?.(0, { hadPrimary: false })

    expect(state.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
      root: { type: 'leaf', leafId: SECOND_LEAF_ID },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SECOND_LEAF_ID]: SECOND_PTY_ID }
    })
  })

  it('prefers a concurrent layout rebind over the watcher leaf', () => {
    startFirstLeafWatcher()
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [LEAF_ID]: SECOND_PTY_ID,
      [SECOND_LEAF_ID]: PTY_ID
    })

    watcherTransport.exitCallbacks.get(PTY_ID)?.(0, { hadPrimary: false })

    expect(state.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: SECOND_PTY_ID }
    })
  })

  it.each(['generation', 'worktree'] as const)(
    'rejects a watcher leaf after its %s identity becomes stale',
    (staleIdentity) => {
      startFirstLeafWatcher()
      if (staleIdentity === 'generation') {
        state.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, ptyId: PTY_ID, generation: 2 }]
      } else {
        parkedWatchersByTabId.set(TAB_ID, {
          worktreeId: OTHER_WORKTREE_ID,
          tabPtyId: PTY_ID,
          paneIdByPtyId: new Map(),
          disposersByPtyId: new Map()
        })
      }
      state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
        [SECOND_LEAF_ID]: SECOND_PTY_ID
      })

      watcherTransport.exitCallbacks.get(PTY_ID)?.(0, { hadPrimary: false })

      expect(state.setTabLayout).not.toHaveBeenCalled()
    }
  )

  it('prefers the current layout binding over a stale captured leaf', () => {
    capture(WORKTREE_ID, 1)
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [LEAF_ID]: SECOND_PTY_ID,
      [SECOND_LEAF_ID]: PTY_ID
    })

    collapseParkedExitedLeaf(TAB_ID, PTY_ID)

    expect(state.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: SECOND_PTY_ID }
    })
  })

  it('does not detach a replacement occupant through the capture fallback', () => {
    capture(WORKTREE_ID, 1)
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [LEAF_ID]: REPLACEMENT_PTY_ID,
      [SECOND_LEAF_ID]: SECOND_PTY_ID
    })

    collapseParkedExitedLeaf(TAB_ID, PTY_ID)

    expect(state.setTabLayout).not.toHaveBeenCalled()
  })

  it('uses a current capture when its leaf is unbound in the layout', () => {
    capture(WORKTREE_ID, 1)
    state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
      [SECOND_LEAF_ID]: SECOND_PTY_ID
    })

    collapseParkedExitedLeaf(TAB_ID, PTY_ID)

    expect(state.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
      root: { type: 'leaf', leafId: SECOND_LEAF_ID },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SECOND_LEAF_ID]: SECOND_PTY_ID }
    })
  })

  it.each(['generation', 'worktree'] as const)(
    'does not detach a leaf from a %s-stale capture',
    (staleIdentity) => {
      capture(staleIdentity === 'worktree' ? OTHER_WORKTREE_ID : WORKTREE_ID, 1)
      if (staleIdentity === 'generation') {
        state.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, ptyId: PTY_ID, generation: 2 }]
      }
      state.terminalLayoutsByTabId[TAB_ID] = splitLayout({
        [SECOND_LEAF_ID]: SECOND_PTY_ID
      })

      collapseParkedExitedLeaf(TAB_ID, PTY_ID)

      expect(state.setTabLayout).not.toHaveBeenCalled()
    }
  )
})
