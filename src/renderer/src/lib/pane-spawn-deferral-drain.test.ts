import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({
    automaticWork: { admission: 'enforce', mode: { kind: 'normal' } }
  }))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

const { queueDeferredRestoreRetry, cancelDeferredRestoreRetry, resetDeferredRestoreDrainForTests } =
  await import('./pane-spawn-deferral-drain')

beforeEach(() => {
  vi.useFakeTimers()
  callRuntimeRpc.mockClear()
})

afterEach(() => {
  resetDeferredRestoreDrainForTests()
  vi.useRealTimers()
})

describe('the background retry of restores a host kept asleep', () => {
  it('asks again after a while, without anyone opening the pane', async () => {
    const retry = vi.fn(async () => true)
    queueDeferredRestoreRetry('tab:a', null, retry)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'runtime.automaticWork.status',
      undefined,
      expect.anything()
    )
  })

  it('asks one pane per host at a time and takes the next soon after one starts', async () => {
    const order: string[] = []
    const retry = (name: string) => vi.fn(async () => (order.push(name), true))
    queueDeferredRestoreRetry('tab:a', 'env-1', retry('a'))
    queueDeferredRestoreRetry('tab:b', 'env-1', retry('b'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(order).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(['a', 'b'])
  })

  it('backs off while the host keeps deferring, up to five minutes', async () => {
    const asks: number[] = []
    const retry = vi.fn(async () => {
      asks.push(Date.now())
      // Deferred again: the pane queues itself anew, as enterSpawnDeferredSleep does.
      queueDeferredRestoreRetry('tab:a', null, retry)
      return false
    })
    const start = Date.now()
    queueDeferredRestoreRetry('tab:a', null, retry)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const gaps = asks.map((at, index) => at - (index === 0 ? start : asks[index - 1]))
    expect(gaps.slice(0, 5)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000])
    expect(Math.max(...gaps)).toBe(300_000)
  })

  it('never spawns on a host it cannot reach or whose restores are paused', async () => {
    const retry = vi.fn(async () => true)
    callRuntimeRpc.mockRejectedValueOnce(new Error('offline'))
    callRuntimeRpc.mockResolvedValueOnce({
      automaticWork: { admission: 'enforce', mode: { kind: 'paused' } }
    })
    queueDeferredRestoreRetry('tab:a', 'env-1', retry)
    await vi.advanceTimersByTimeAsync(30_000 + 60_000)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('drops a pane that was opened or closed meanwhile', async () => {
    const retry = vi.fn(async () => true)
    queueDeferredRestoreRetry('tab:a', null, retry)
    cancelDeferredRestoreRetry('tab:a')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(retry).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps each host’s backoff to itself', async () => {
    const capped = vi.fn(async () => {
      queueDeferredRestoreRetry('tab:a', 'env-1', capped)
      return false
    })
    const roomy = vi.fn(async () => true)
    queueDeferredRestoreRetry('tab:a', 'env-1', capped)
    await vi.advanceTimersByTimeAsync(90_000)
    queueDeferredRestoreRetry('tab:b', 'env-2', roomy)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(roomy).toHaveBeenCalledTimes(1)
  })
})
