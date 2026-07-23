import { describe, expect, it } from 'vitest'
import { createWebRuntimeOutboundMemoryBudget } from './web-runtime-outbound-memory-budget'

describe('web runtime outbound memory budget', () => {
  it('bounds aggregate queued bytes and frames with capacity recovery', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({
      maxQueuedBytes: 10,
      maxQueuedFrames: 2
    })
    const first = budget.claimQueuedBytes(5)
    const second = budget.claimQueuedBytes(5)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(budget.claimQueuedBytes(0)).toBeNull()
    first?.()
    expect(budget.claimQueuedBytes(5)).not.toBeNull()
  })

  it('accepts exact retained subscription bytes and releases them', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({ maxSubscriptionBytes: 10 })
    const release = budget.claimSubscriptionBytes(10)

    expect(release).not.toBeNull()
    expect(budget.claimSubscriptionBytes(1)).toBeNull()
    release?.()
    expect(budget.claimSubscriptionBytes(10)).not.toBeNull()
  })

  it('bounds prepared RPC bytes across connection waiters and releases them', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({ maxPreparedRpcBytes: 10 })
    const release = budget.claimPreparedRpcBytes(10)

    expect(release).not.toBeNull()
    expect(budget.claimPreparedRpcBytes(1)).toBeNull()
    release?.()
    expect(budget.claimPreparedRpcBytes(10)).not.toBeNull()
  })

  it('accounts native buffered amounts across registered child sockets', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({
      maxBufferedBytes: 10,
      maxSocketSources: 2
    })
    let firstBytes = 6
    let secondBytes = 3
    const first = budget.registerBufferedAmount(() => firstBytes)
    const second = budget.registerBufferedAmount(() => secondBytes)

    expect(first.canSend(1)).toBe(true)
    expect(first.canSend(2)).toBe(false)
    secondBytes = 0
    expect(first.canSend(4)).toBe(true)
    firstBytes = 0
    second.release()
    expect(first.canSend(10)).toBe(true)
  })

  it('caps tracked sockets and recovers when a socket closes', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({ maxSocketSources: 1 })
    const socket = budget.registerBufferedAmount(() => 0)

    expect(() => budget.registerBufferedAmount(() => 0)).toThrow('socket tracking limit')
    socket.release()
    expect(() => budget.registerBufferedAmount(() => 0)).not.toThrow()
  })
})
