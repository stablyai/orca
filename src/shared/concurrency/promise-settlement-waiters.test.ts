import { describe, expect, it, vi } from 'vitest'
import { PromiseSettlementWaiters } from './promise-settlement-waiters'

describe('PromiseSettlementWaiters', () => {
  it.each([false, true])('preserves abort scheduling with abortInMicrotask=%s', async (defer) => {
    let resolveBase = (_value: string): void => {}
    const base = new Promise<string>((resolve) => {
      resolveBase = resolve
    })
    const waiters = new PromiseSettlementWaiters(base)
    const controller = new AbortController()
    const reason = { code: 'aborted' }
    const wait = waiters.wait({
      signal: controller.signal,
      abortInMicrotask: defer,
      createAbortError: () => reason
    })
    resolveBase('raw result')
    controller.abort()
    await (defer ? expect(wait).resolves.toBe('raw result') : expect(wait).rejects.toBe(reason))
    expect(waiters.waiterCount).toBe(0)
  })

  it('lets an earlier deferred abort win over a later raw settlement', async () => {
    let resolveBase = (_value: string): void => {}
    const base = new Promise<string>((resolve) => {
      resolveBase = resolve
    })
    const waiters = new PromiseSettlementWaiters(base)
    const controller = new AbortController()
    const wait = waiters.wait({
      signal: controller.signal,
      abortInMicrotask: true,
      createAbortError: () => false
    })
    controller.abort()
    resolveBase('raw result')
    await expect(wait).rejects.toBe(false)
    expect(waiters.waiterCount).toBe(0)
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
