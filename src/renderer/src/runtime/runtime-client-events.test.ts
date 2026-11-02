import { describe, expect, it, vi } from 'vitest'
import type { SshProviderEpoch } from '../../../shared/ssh-types'
import { subscribeRuntimeClientEvents } from './runtime-client-events'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from './runtime-environment-bridge-fixture'

describe('subscribeRuntimeClientEvents', () => {
  it('preserves full SSH authority in retained snapshots and live client events', async () => {
    const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
    const onEvent = vi.fn()
    stubRuntimeEnvironmentBridge({ subscribe })
    await subscribeRuntimeClientEvents('env-1', onEvent)
    respond({
      ok: true,
      result: {
        type: 'ready',
        subscriptionId: 'sub-1',
        snapshot: {
          sshStates: [
            {
              targetId: 'ssh-1',
              state: {
                targetId: 'ssh-1',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                providerEpoch: 'snapshot-provider-epoch' as SshProviderEpoch,
                connectionGeneration: 17
              }
            }
          ]
        }
      }
    })

    expect(onEvent).toHaveBeenCalledWith({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'snapshot-provider-epoch',
        connectionGeneration: 17
      }
    })

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
          providerEpoch: 'live-provider-epoch' as SshProviderEpoch,
          connectionGeneration: 18
        }
      }
    })

    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'live-provider-epoch',
        connectionGeneration: 18
      }
    })
  })

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

it('existing desktop reader ignores additive phone preference fields and events', async () => {
  const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'old-reader' })
  stubRuntimeEnvironmentBridge({ subscribe })
  const onEvent = vi.fn(),
    onError = vi.fn()
  const subscription = await subscribeRuntimeClientEvents('env-old', onEvent, onError)
  respond({
    ok: true,
    result: {
      type: 'ready',
      subscriptionId: 'old-reader',
      snapshot: { nativeChatQueueFollowUps: true }
    }
  })
  respond({ ok: true, result: { type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false } })
  expect(onEvent).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  subscription.unsubscribe()
})
