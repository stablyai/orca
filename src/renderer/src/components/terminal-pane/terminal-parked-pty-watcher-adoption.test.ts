import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const disposeByteWatcher = vi.fn()
const startParkedTerminalByteWatcher = vi.fn(
  (_options: ParkedTerminalByteWatcherOptions) => disposeByteWatcher
)
vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: (options: ParkedTerminalByteWatcherOptions) =>
    startParkedTerminalByteWatcher(options)
}))

const unsubscribeExit = vi.fn()
let exitWatcher: ((code: number, context: { hadPrimary: boolean }) => void) | null = null
const subscribeToPtyExit = vi.fn(
  (
    _ptyId: string,
    watcher: (code: number, context: { hadPrimary: boolean }) => void,
    _options?: { adoptPreHandlerExit?: boolean }
  ) => {
    exitWatcher = watcher
    return unsubscribeExit
  }
)
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (
    ptyId: string,
    watcher: (code: number, context: { hadPrimary: boolean }) => void,
    options?: { adoptPreHandlerExit?: boolean }
  ) => subscribeToPtyExit(ptyId, watcher, options)
}))

const storeState = {
  runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
  settings: null,
  clearRuntimePaneTitle: vi.fn()
}
vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

import { startParkedPtyWatcher } from './terminal-parked-pty-watcher'

describe('parked PTY watcher handoff adoption', () => {
  afterEach(() => {
    exitWatcher = null
    vi.clearAllMocks()
  })

  function createEntry() {
    return {
      worktreeId: WORKTREE_ID,
      tabPtyId: PTY_ID,
      paneIdByPtyId: new Map<string, number>(),
      disposersByPtyId: new Map<string, () => void>()
    }
  }

  it('opts the parked exit owner into buffered-exit adoption', () => {
    const entry = createEntry()

    startParkedPtyWatcher({
      worktreeId: WORKTREE_ID,
      tab: { id: TAB_ID, ptyId: PTY_ID, generation: 0 },
      pane: { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      entry,
      restoreTitleOnRegister: false,
      restorePolicy: { sshParkingEnabled: true }
    })

    expect(subscribeToPtyExit).toHaveBeenCalledWith(PTY_ID, expect.any(Function), {
      adoptPreHandlerExit: true
    })
    entry.disposersByPtyId.get(PTY_ID)?.()
    expect(unsubscribeExit).toHaveBeenCalledOnce()
    expect(disposeByteWatcher).toHaveBeenCalledOnce()
  })

  it('rolls back the byte watcher when exit subscription fails', () => {
    const entry = createEntry()
    entry.paneIdByPtyId.set(PTY_ID, 7)
    subscribeToPtyExit.mockImplementationOnce(() => {
      throw new Error('exit subscription failed')
    })

    expect(() =>
      startParkedPtyWatcher({
        worktreeId: WORKTREE_ID,
        tab: { id: TAB_ID, ptyId: PTY_ID, generation: 0 },
        pane: { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        entry,
        restoreTitleOnRegister: false,
        restorePolicy: { sshParkingEnabled: true }
      })
    ).toThrow('exit subscription failed')

    expect(disposeByteWatcher).toHaveBeenCalledOnce()
    expect(entry.paneIdByPtyId.has(PTY_ID)).toBe(false)
    expect(entry.disposersByPtyId.has(PTY_ID)).toBe(false)
  })

  it('detaches watcher ownership before adopted-exit store cleanup', () => {
    const entry = createEntry()
    startParkedPtyWatcher({
      worktreeId: WORKTREE_ID,
      tab: { id: TAB_ID, ptyId: PTY_ID, generation: 0 },
      pane: { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      entry,
      restoreTitleOnRegister: false,
      restorePolicy: { sshParkingEnabled: true }
    })
    storeState.clearRuntimePaneTitle.mockImplementationOnce(() => {
      throw new Error('store cleanup failed')
    })

    expect(() => exitWatcher?.(0, { hadPrimary: false })).toThrow('store cleanup failed')

    expect(disposeByteWatcher).toHaveBeenCalledOnce()
    expect(entry.disposersByPtyId.has(PTY_ID)).toBe(false)
  })
})
