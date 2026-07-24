import { describe, expect, it, vi } from 'vitest'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'

describe('SharedControlSocketGeneration', () => {
  it('ignores stale close callbacks and accepts one close for the current socket', () => {
    const generations = new SharedControlSocketGeneration()
    const stale = generations.begin()
    const current = generations.begin()
    const closeSocket = vi.fn()
    const onError = vi.fn()
    const throwingOnError = vi.fn(() => {
      throw new Error('consumer failed')
    })
    const subscriptions = new Map([
      [
        'subscription-1',
        {
          requestId: 'subscription-1',
          method: 'session.tabs.subscribeAll',
          params: null,
          callbacks: { onResponse: vi.fn(), onError },
          sent: true,
          closed: false,
          closeAfterReady: false,
          remoteSubscriptionId: 'remote-1'
        }
      ],
      [
        'subscription-2',
        {
          requestId: 'subscription-2',
          method: 'runtime.clientEvents.subscribe',
          params: null,
          callbacks: { onResponse: vi.fn(), onError: throwingOnError },
          sent: true,
          closed: false,
          closeAfterReady: false,
          remoteSubscriptionId: 'remote-2'
        }
      ]
    ])
    const args = {
      error: remoteRuntimeUnavailableError(),
      everReady: true,
      subscriptions,
      closeSocket
    }

    expect(generations.acceptClose({ ...args, generation: stale })).toBe(false)
    expect(generations.acceptClose({ ...args, generation: current })).toBe(true)
    expect(generations.acceptClose({ ...args, generation: current })).toBe(false)
    expect(closeSocket).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(throwingOnError).toHaveBeenCalledTimes(1)
  })
})
