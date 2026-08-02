import { describe, expect, it, vi } from 'vitest'
import { PromiseSettlementWaiters } from './promise-settlement-waiters'

describe('PromiseSettlementWaiters', () => {
  it('removes ten thousand aborted callers while one anchor remains pending', async () => {
    let resolveBase: (value: number) => void = () => {}
    const basePromise = new Promise<number>((resolve) => {
      resolveBase = resolve
    })
    const thenSpy = vi.spyOn(basePromise, 'then')
    const waiters = new PromiseSettlementWaiters(basePromise)
    const anchor = waiters.wait()
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller) =>
      waiters.wait({ signal: controller.signal }).catch((error) => error)
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    expect(waiters.waiterCount).toBe(1)
    expect(thenSpy).toHaveBeenCalledOnce()
    resolveBase(42)
    await expect(anchor).resolves.toBe(42)
    expect(waiters.waiterCount).toBe(0)
  })

  it('removes timed-out callers and clears their timers on settlement', async () => {
    vi.useFakeTimers()
    try {
      let resolveBase: () => void = () => {}
      const waiters = new PromiseSettlementWaiters(
        new Promise<void>((resolve) => {
          resolveBase = resolve
        })
      )
      const timedOut = waiters
        .wait({ timeoutMs: 10, createTimeoutError: () => new Error('late') })
        .catch((error) => error)
      const active = waiters.wait({ timeoutMs: 100 })

      await vi.advanceTimersByTimeAsync(10)
      await expect(timedOut).resolves.toMatchObject({ message: 'late' })
      expect(waiters.waiterCount).toBe(1)
      resolveBase()
      await expect(active).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifies ownership cleanup for an already-aborted caller', async () => {
    const controller = new AbortController()
    controller.abort()
    const onAbandon = vi.fn()
    const waiters = new PromiseSettlementWaiters(new Promise<void>(() => {}))

    await expect(waiters.wait({ signal: controller.signal, onAbandon })).rejects.toMatchObject({
      name: 'AbortError'
    })

    expect(onAbandon).toHaveBeenCalledWith('abort')
    expect(waiters.waiterCount).toBe(0)
  })
})
