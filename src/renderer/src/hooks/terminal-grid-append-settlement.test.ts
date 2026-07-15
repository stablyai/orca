import { describe, expect, it, vi } from 'vitest'
import { TerminalGridAppendSettlementRegistry } from './terminal-grid-append-settlement'

const identity = {
  transactionId: 'grid-append-1',
  tabId: 'tab-grid',
  leafId: '11111111-1111-4111-8111-111111111111'
}

describe('TerminalGridAppendSettlementRegistry', () => {
  it('rolls back the exact append once and acknowledges a retry idempotently', () => {
    const rollback = vi.fn()
    const registry = new TerminalGridAppendSettlementRegistry()
    registry.register({ ...identity, rollback })

    registry.rollback(identity)
    registry.rollback(identity)

    expect(rollback).toHaveBeenCalledOnce()
  })

  it('keeps a failed rollback pending so a later acknowledgement can retry it', () => {
    const rollback = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient close failure')
      })
      .mockImplementationOnce(() => undefined)
    const registry = new TerminalGridAppendSettlementRegistry()
    registry.register({ ...identity, rollback })

    expect(() => registry.rollback(identity)).toThrow('transient close failure')
    expect(() => registry.rollback(identity)).not.toThrow()
    expect(rollback).toHaveBeenCalledTimes(2)
  })

  it('rejects a settlement that could remove a legitimate sibling leaf', () => {
    const rollback = vi.fn()
    const registry = new TerminalGridAppendSettlementRegistry()
    registry.register({ ...identity, rollback })

    expect(() =>
      registry.rollback({
        ...identity,
        leafId: '22222222-2222-4222-8222-222222222222'
      })
    ).toThrow('identity does not match')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('discards rollback authority after durable commit', () => {
    const rollback = vi.fn()
    const registry = new TerminalGridAppendSettlementRegistry()
    registry.register({ ...identity, rollback })

    registry.complete(identity)
    registry.rollback(identity)

    expect(rollback).not.toHaveBeenCalled()
  })
})
