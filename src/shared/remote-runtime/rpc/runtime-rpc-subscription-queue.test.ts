import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'
import { enqueueRuntimeSubscription } from './runtime-rpc-subscription-queue'

const TIMED_PR_PARAMS = { reason: 'swr' }

describe('enqueueRuntimeSubscription', () => {
  it('never opens a timed subscription canceled before its open runs', async () => {
    const pool = new RuntimeRpcCallQueuePool()
    const opened: string[] = []
    const subscribe = (name: string, signal?: AbortSignal): Promise<string> =>
      enqueueRuntimeSubscription(
        pool,
        'env',
        'github.prForBranch',
        TIMED_PR_PARAMS,
        async (complete) => {
          opened.push(name)
          queueMicrotask(complete)
          return name
        },
        () => {},
        signal
      )
    const controller = new AbortController()
    const reason = new Error('canceled')
    const canceled = subscribe('canceled', controller.signal)
    controller.abort(reason)

    await expect(canceled).rejects.toBe(reason)
    await expect(subscribe('live')).resolves.toBe('live')
    expect(opened).toEqual(['live'])
  })
})
