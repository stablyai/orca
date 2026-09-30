import { describe, expect, it } from 'vitest'
import { PrioritySemaphore } from './priority-semaphore'

describe('PrioritySemaphore', () => {
  it('blocks when concurrency limit is reached', async () => {
    const sem = new PrioritySemaphore(1)
    const r1 = await sem.acquire(0)

    let acquired = false
    const p2 = sem.acquire(0).then((r) => {
      acquired = true
      return r
    })

    // Give microtasks a chance to flush
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false)

    r1()
    const r2 = await p2
    expect(acquired).toBe(true)
    r2()
  })

  it('serves higher priority (lower number) first', async () => {
    const sem = new PrioritySemaphore(1)
    const r1 = await sem.acquire(0)

    const order: string[] = []

    // Queue a low-priority and then a high-priority waiter
    const pLow = sem.acquire(1).then((r) => {
      order.push('low')
      return r
    })
    const pHigh = sem.acquire(0).then((r) => {
      order.push('high')
      return r
    })

    // Release — high priority should go first
    r1()

    const rHigh = await pHigh
    rHigh()

    const rLow = await pLow
    rLow()

    expect(order).toEqual(['high', 'low'])
  })

  it('handles FIFO within same priority', async () => {
    const sem = new PrioritySemaphore(1)
    const r1 = await sem.acquire(0)

    const order: number[] = []

    const p1 = sem.acquire(1).then((r) => {
      order.push(1)
      return r
    })
    const p2 = sem.acquire(1).then((r) => {
      order.push(2)
      return r
    })
    const p3 = sem.acquire(1).then((r) => {
      order.push(3)
      return r
    })

    r1()

    const r2 = await p1
    r2()
    const r3 = await p2
    r3()
    const r4 = await p3
    r4()

    expect(order).toEqual([1, 2, 3])
  })

  it('supports concurrency > 1 with priority ordering', async () => {
    const sem = new PrioritySemaphore(2)
    const r1 = await sem.acquire(0)
    const r2 = await sem.acquire(0)

    const order: string[] = []

    const pA = sem.acquire(1).then((r) => {
      order.push('A-low')
      return r
    })
    const pB = sem.acquire(0).then((r) => {
      order.push('B-high')
      return r
    })
    const pC = sem.acquire(1).then((r) => {
      order.push('C-low')
      return r
    })

    // Release both slots
    r1()
    r2()

    // High priority B should get a slot before low-priority A and C
    const rB = await pB
    rB()
    const rA = await pA
    rA()
    const rC = await pC
    rC()

    expect(order[0]).toBe('B-high')
  })

  it('removes an aborted waiter without consuming the next permit', async () => {
    const sem = new PrioritySemaphore(1)
    const release = await sem.acquire(0)
    const controller = new AbortController()
    const reason = new Error('canceled')
    const waiting = sem.acquire(0, controller.signal)

    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    release()

    const nextRelease = await sem.acquire(0)
    nextRelease()
  })
})
