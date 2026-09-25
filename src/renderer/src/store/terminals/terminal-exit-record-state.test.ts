import { describe, expect, it } from 'vitest'
import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import { createTestStore } from '../slices/store-test-helpers'

function exitRecord(leafId: string, ptyId: string): TerminalExitRecord {
  return {
    worktreeId: 'wt-1',
    leafId,
    ptyId,
    incarnationId: `inc-${ptyId}`,
    exitCode: 3,
    cause: { kind: 'exited', exitCode: 3 },
    exitedAt: 1
  }
}

describe('terminal exit record mirror', () => {
  it('keeps the pending restart map every pane subscribes to when an unrelated leaf exits', () => {
    const store = createTestStore()
    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a')])
    store.getState().requestExitedTerminalRestart('leaf-a')
    const pending = store.getState().pendingExitedTerminalRestartLeafIds

    store
      .getState()
      .replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a'), exitRecord('leaf-b', 'pty-b')])

    expect(store.getState().pendingExitedTerminalRestartLeafIds).toBe(pending)
  })

  it('publishes nothing for a push equal to what the mirror holds', () => {
    const store = createTestStore()
    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a')])
    const before = store.getState()

    // Why a fresh object: each IPC push arrives as a new structured clone.
    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a')])
    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a')])
    store.getState().requestExitedTerminalRestart('leaf-a')
    const requested = store.getState()
    store.getState().requestExitedTerminalRestart('leaf-a')

    expect(requested.terminalExitRecordsByLeafId).toBe(before.terminalExitRecordsByLeafId)
    expect(store.getState()).toBe(requested)
  })

  it('replaces a leaf whose record names a later exit', () => {
    const store = createTestStore()
    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a')])

    store.getState().replaceTerminalExitRecords([exitRecord('leaf-a', 'pty-a2')])

    expect(store.getState().terminalExitRecordsByLeafId['leaf-a']?.ptyId).toBe('pty-a2')
  })
})
