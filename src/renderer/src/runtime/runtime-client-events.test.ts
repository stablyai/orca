import { describe, expect, it, vi } from 'vitest'

import { subscribeRuntimeClientEvents } from './runtime-client-events'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from './runtime-environment-bridge-fixture'

describe('subscribeRuntimeClientEvents', () => {
  it('rejects a partial runtime authority instead of retaining it', async () => {
    const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
    const onEvent = vi.fn()
    const onError = vi.fn()
    stubRuntimeEnvironmentBridge({ subscribe })
    await subscribeRuntimeClientEvents('env-1', onEvent, onError)

    respond({
      ok: true,
      result: {
        type: 'sshStateChanged',
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: 'partial-provider-epoch'
        }
      }
    })

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
  })
})
