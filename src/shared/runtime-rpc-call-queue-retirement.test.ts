import { expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueueBusyError, RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'

it('refuses an active or queued selector without interrupting or replaying its calls', async () => {
  const queue = new RuntimeRpcCallQueuePool(1, 1)
  const pending = Promise.withResolvers<string>()
  const first = queue.enqueue('host', 'terminal.send', () => pending.promise)
  const secondRun = vi.fn(async () => 'second-ack')
  const second = queue.enqueue('host', 'terminal.send', secondRun)
  expect(() => queue.holdIdleSelectors(['host'])).toThrow(RuntimeRpcCallQueueBusyError)
  pending.resolve('first-ack')
  await expect(first).resolves.toBe('first-ack')
  await expect(second).resolves.toBe('second-ack')
  expect(secondRun).toHaveBeenCalledOnce()
  await vi.waitFor(() => queue.holdIdleSelectors(['host'])())
})

it('holds both identities, refuses new calls before dispatch, and leaves other hosts running', async () => {
  const queue = new RuntimeRpcCallQueuePool()
  const release = queue.holdIdleSelectors(['canonical', 'historical', 'canonical'])
  const run = vi.fn(async () => 'ack')
  for (const id of ['canonical', 'historical']) {
    await expect(queue.enqueue(id, 'terminal.send', run)).rejects.toMatchObject({
      code: 'runtime_rpc_queue_busy'
    })
  }
  expect(run).not.toHaveBeenCalled()
  await expect(queue.enqueue('other', 'terminal.send', run)).resolves.toBe('ack')
  release()
  await expect(queue.enqueue('historical', 'terminal.send', run)).resolves.toBe('ack')
  expect(run).toHaveBeenCalledTimes(2)
})

it('acquires a group atomically without retaining a partial hold on failure', async () => {
  const queue = new RuntimeRpcCallQueuePool()
  const release = queue.holdIdleSelectors(['historical'])
  expect(() => queue.holdIdleSelectors(['canonical', 'historical'])).toThrow(
    RuntimeRpcCallQueueBusyError
  )
  await expect(queue.enqueue('canonical', 'repo.list', async () => 'ok')).resolves.toBe('ok')
  release()
})

it('does not let an old release clear a newer hold', async () => {
  const queue = new RuntimeRpcCallQueuePool()
  const first = queue.holdIdleSelectors(['host'])
  first()
  const second = queue.holdIdleSelectors(['host'])
  first()
  await expect(queue.enqueue('host', 'repo.list', async () => 'ok')).rejects.toThrow(
    RuntimeRpcCallQueueBusyError
  )
  second()
  await expect(queue.enqueue('host', 'repo.list', async () => 'ok')).resolves.toBe('ok')
})
