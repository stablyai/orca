import { describe, expect, it } from 'vitest'

import { subscribeRuntimeClientEvents } from './runtime-client-events'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from '../testing/runtime-environment-bridge-fixture'

describe('subscribeRuntimeClientEvents', () => {
  it('rejects a partial runtime authority instead of retaining it', async () => {
    const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
    const observed: string[] = []
    stubRuntimeEnvironmentBridge({ subscribe })
    await subscribeRuntimeClientEvents(
      'env-1',
      () => observed.push('event'),
      () => observed.push('error')
    )

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

    expect(observed).toEqual(['error'])
  })
})
