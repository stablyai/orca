/** Verify the running-terminal close confirmation state machine: an opted-in repeat close of the visible tab confirms both callers, while the inter-request guard and default async-probe folding still block killing an unseen tab. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunningTerminalCloseConfirmStore } from './running-terminal-close-confirm'

function clearPendingConfirmations(): void {
  const store = useRunningTerminalCloseConfirmStore.getState()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm !== null) {
    vi.advanceTimersByTime(1_000)
    store.dismissRunningTerminalClose()
  }
}

describe('running-terminal-close-confirm state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'))
    clearPendingConfirmations()
  })

  afterEach(() => {
    clearPendingConfirmations()
    vi.useRealTimers()
  })

  it('confirms the visible prompt and resolves both callers when confirmDuplicate is set', () => {
    const events: string[] = []
    const store = useRunningTerminalCloseConfirmStore.getState()

    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      onConfirm: () => events.push('first-confirm')
    })
    store.requestRunningTerminalCloseConfirm(
      {
        terminalTabId: 'tab-1',
        copyKind: 'agent',
        onConfirm: () => events.push('repeat-confirm')
      },
      { confirmDuplicate: true }
    )

    expect(events).toEqual(['first-confirm', 'repeat-confirm'])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('blocks a repeat close from killing a freshly revealed queued tab during the inter-request guard', () => {
    const events: string[] = []
    const store = useRunningTerminalCloseConfirmStore.getState()

    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      onConfirm: () => events.push('tab-1')
    })
    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-2',
      copyKind: 'command',
      onConfirm: () => events.push('tab-2-first')
    })

    store.confirmRunningTerminalClose()
    store.requestRunningTerminalCloseConfirm(
      {
        terminalTabId: 'tab-2',
        copyKind: 'command',
        onConfirm: () => events.push('tab-2-repeat')
      },
      { confirmDuplicate: true }
    )

    expect(events).toEqual(['tab-1'])
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.terminalTabId
    ).toBe('tab-2')

    vi.advanceTimersByTime(400)
    store.confirmRunningTerminalClose()

    expect(events).toEqual(['tab-1', 'tab-2-first', 'tab-2-repeat'])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('folds pre-prompt duplicate probes by default without confirming unseen', () => {
    const events: string[] = []
    const store = useRunningTerminalCloseConfirmStore.getState()

    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      onConfirm: () => events.push('confirm-1'),
      onCancel: () => events.push('cancel-1')
    })
    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      onConfirm: () => events.push('confirm-2'),
      onCancel: () => events.push('cancel-2')
    })

    expect(events).toEqual([])
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.terminalTabId
    ).toBe('tab-1')

    store.dismissRunningTerminalClose()

    expect(events).toEqual(['cancel-1', 'cancel-2'])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })
})
