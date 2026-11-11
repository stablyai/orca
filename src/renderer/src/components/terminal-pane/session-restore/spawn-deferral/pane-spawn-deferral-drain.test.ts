import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({
    automaticWork: { admission: 'enforce', mode: { kind: 'normal' } }
  }))
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc
}))

const { queueDeferredRestoreRetry, resetDeferredRestoreDrainForTests } =
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
})
