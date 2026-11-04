import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunningTerminalCloseConfirmStore } from './running-terminal-close-confirm'

// Drive clock for the 350ms queued-prompt guard; wall time must not decide actions.
let clock = 1_000

function advancePastGuard(): void {
  clock += 400
}

function drainRequests(): void {
  const store = useRunningTerminalCloseConfirmStore.getState()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm) {
    advancePastGuard()
    store.dismissRunningTerminalClose()
  }
}

function request(terminalTabId: string, onConfirm: () => void = vi.fn(), onCancel?: () => void) {
  return {
    terminalTabId,
    tabLabel: terminalTabId,
    copyKind: 'command' as const,
    onConfirm,
    ...(onCancel ? { onCancel } : {})
  }
}

describe('running terminal close confirmation store', () => {
  beforeEach(() => {
    // Keep singleton clock monotonic or prior guard deadlines block later cases.
    clock += 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    drainRequests()
    vi.mocked(Date.now).mockRestore()
  })

  it('lets a re-entrant close from onConfirm queue behind the next request', () => {
    const store = useRunningTerminalCloseConfirmStore.getState()
    const reentrant = vi.fn()
    const second = vi.fn()

    store.requestRunningTerminalCloseConfirm(
      request('tab-1', () => {
        // Why: the real onConfirm re-enters closeTerminalTab, which may request again.
        store.requestRunningTerminalCloseConfirm(request('tab-3', reentrant))
      })
    )
    store.requestRunningTerminalCloseConfirm(request('tab-2', second))
    store.confirmRunningTerminalClose()

    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.terminalTabId
    ).toBe('tab-2')

    advancePastGuard()
    store.confirmRunningTerminalClose()
    expect(second).toHaveBeenCalledTimes(1)
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.terminalTabId
    ).toBe('tab-3')

    advancePastGuard()
    store.confirmRunningTerminalClose()
    expect(reentrant).toHaveBeenCalledTimes(1)
  })

  // Queued prompts reuse the dialog; guard double-clicks from accepting the next unseen tab’s process close.
  it('ignores a second action that lands on the freshly revealed request', () => {
    const store = useRunningTerminalCloseConfirmStore.getState()
    const first = vi.fn()
    const second = vi.fn()

    store.requestRunningTerminalCloseConfirm(request('tab-1', first))
    store.requestRunningTerminalCloseConfirm(request('tab-2', second))

    store.confirmRunningTerminalClose()
    store.confirmRunningTerminalClose()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.terminalTabId
    ).toBe('tab-2')

    advancePastGuard()
    store.confirmRunningTerminalClose()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
