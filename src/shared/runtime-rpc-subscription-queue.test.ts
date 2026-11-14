import { expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'
import { enqueueRuntimeSubscription } from './runtime-rpc-subscription-queue'

it('shares timed occupancy with one-shot calls through first response and removes a queued abort', async () => {
  const pool = new RuntimeRpcCallQueuePool()
  const oneShot = Promise.withResolvers<void>()
  const running = pool.enqueue('host', 'github.prForBranch', () => oneShot.promise, 0, undefined, {
    reason: 'swr'
  })
  let respond = (): void => {}
  const close = vi.fn()
  const handle = await enqueueRuntimeSubscription(
    pool,
    'host',
    'github.prForBranch',
    { reason: 'swr' },
    async (complete) => {
      respond = complete
      return { close }
    },
    (value) => value.close()
  )
  const controller = new AbortController()
  const sendThird = vi.fn(async () => ({ close }))
  const third = enqueueRuntimeSubscription(
    pool,
    'host',
    'github.prForBranch',
    { reason: 'swr' },
    sendThird,
    (value) => value.close(),
    controller.signal
  )
  const rejected = expect(third).rejects.toThrow()
  await expect(pool.enqueue('host', 'git.status', async () => 'clean')).resolves.toBe('clean')
  expect(sendThird).not.toHaveBeenCalled()
  controller.abort()
  await rejected
  respond()
  await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
  expect(handle).toEqual({ close })
  oneShot.resolve()
  await running
})

it('releases a response before setup settles and closes its late handle', async () => {
  const pool = new RuntimeRpcCallQueuePool()
  const late = Promise.withResolvers<{ close: () => void }>()
  const close = vi.fn()
  const setup = enqueueRuntimeSubscription(
    pool,
    'host',
    'github.prForBranch',
    { reason: 'swr' },
    (complete) => {
      complete()
      return late.promise
    },
    (value) => value.close()
  )
  await expect(
    pool.enqueue('host', 'github.prForBranch', async () => 'next', 0, undefined, { reason: 'swr' })
  ).resolves.toBe('next')
  late.resolve({ close })
  await setup
  expect(close).toHaveBeenCalledOnce()
})

it('cancels an active setup, closes its late handle, and recovers after setup rejection', async () => {
  const pool = new RuntimeRpcCallQueuePool()
  const late = Promise.withResolvers<{ close: () => void }>()
  const close = vi.fn()
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const setup = enqueueRuntimeSubscription(
    pool,
    'host',
    'github.prForBranch',
    { reason: 'swr' },
    () => {
      started.resolve()
      return late.promise
    },
    (value) => value.close(),
    controller.signal
  )
  const rejected = expect(setup).rejects.toThrow()
  await started.promise
  controller.abort()
  await rejected
  late.resolve({ close })
  await Promise.resolve()
  await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
  await expect(
    enqueueRuntimeSubscription(
      pool,
      'host',
      'github.prForBranch',
      { reason: 'swr' },
      async () => {
        throw new Error('setup failed')
      },
      (value: { close: () => void }) => value.close()
    )
  ).rejects.toThrow('setup failed')
  await expect(
    pool.enqueue('host', 'github.prForBranch', async () => 'recovered', 0, undefined, {
      reason: 'swr'
    })
  ).resolves.toBe('recovered')
})
