import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyData,
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit,
  hasPreHandlerPtyExit
} from './pty-pre-handler-buffer'
import {
  parkedWatchersByTabId,
  pruneParkedTerminalWatchers
} from './terminal-parked-watcher-registry'

const TAB_ID = 'removed-parked-tab'
const PTY_ID = 'removed-worktree@@parked-pty'

describe('terminal parked watcher registry removal', () => {
  afterEach(() => {
    parkedWatchersByTabId.delete(TAB_ID)
    clearPreHandlerPtyState(PTY_ID)
  })

  it('consumes retained state and suppresses a delayed exit for a removed worktree', () => {
    const dispose = vi.fn()
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'removed-worktree',
      tabPtyId: PTY_ID,
      paneIdByPtyId: new Map([[PTY_ID, 1]]),
      disposersByPtyId: new Map([[PTY_ID, dispose]])
    })
    bufferPreHandlerPtyData(PTY_ID, 'final frame')
    bufferPreHandlerPtyExit(PTY_ID, 17)

    pruneParkedTerminalWatchers(new Set())

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(parkedWatchersByTabId.has(TAB_ID)).toBe(false)
    expect(hasPreHandlerPtyExit(PTY_ID)).toBe(false)
    const data = vi.fn()
    drainPreHandlerPtyData(PTY_ID, data)
    expect(data).not.toHaveBeenCalled()

    // Why: the actual kill exit can arrive after sidecar disposal and prune.
    bufferPreHandlerPtyExit(PTY_ID, 18)
    bufferPreHandlerPtyData(PTY_ID, 'delayed final frame')
    const exit = vi.fn()
    const delayedData = vi.fn()
    drainPreHandlerPtyExit(PTY_ID, exit)
    drainPreHandlerPtyData(PTY_ID, delayedData)
    expect(exit).not.toHaveBeenCalled()
    expect(delayedData).not.toHaveBeenCalled()
  })
})
