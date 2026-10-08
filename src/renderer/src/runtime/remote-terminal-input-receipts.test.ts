import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteTerminalInputReceipts,
  REMOTE_TERMINAL_INPUT_RECEIPT_LIMIT,
  REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS
} from './remote-terminal-input-receipts'

describe('remote terminal input receipts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not mistake a later write receipt for receipt of an earlier write', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    const first = receipts.begin()
    const second = receipts.begin()
    receipts.settle(second, 'accepted')
    receipts.dispose()
    expect(warn).toHaveBeenCalledOnce()
    receipts.settle(first, 'accepted')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('warns once when a deadline or teardown leaves delivery uncertain', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    receipts.begin()
    vi.advanceTimersByTime(REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS)
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    receipts.begin()
    receipts.dispose()
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline anchored to the oldest unanswered write', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    const first = receipts.begin()
    vi.advanceTimersByTime(10_000)
    const second = receipts.begin()
    receipts.settle(second, 'accepted')
    vi.advanceTimersByTime(5_000)
    expect(warn).toHaveBeenCalledOnce()
    receipts.settle(first, 'accepted')
    receipts.dispose()
  })

  it('cleans up successful and refused writes without an uncertainty warning', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    receipts.settle(receipts.begin(), 'accepted')
    receipts.settle(receipts.begin(), 'refused')
    receipts.dispose()
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an owner-provided unverifiable settlement', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    receipts.settle(receipts.begin(), 'unverifiable')
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds pending receipts and uses one timer during an input flood', () => {
    const warn = vi.fn()
    const receipts = new RemoteTerminalInputReceipts(warn)
    for (let i = 0; i < REMOTE_TERMINAL_INPUT_RECEIPT_LIMIT; i++) {
      receipts.begin()
    }
    expect(vi.getTimerCount()).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    receipts.begin()
    expect(warn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    receipts.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
