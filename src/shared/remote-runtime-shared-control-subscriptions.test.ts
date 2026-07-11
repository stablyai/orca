import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import {
  closeSharedControlLogicalSubscription,
  createSharedControlSubscription,
  handleSharedControlLogicalResponse,
  replaySharedControlSubscriptions
} from './remote-runtime-shared-control-subscriptions'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

function makeSubscriptions(): {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
} {
  const subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
  const subscription = createSharedControlSubscription({
    requestId: 'req-1',
    method: 'runtime.clientEvents.subscribe',
    params: null,
    callbacks: { onResponse: vi.fn(), onError: vi.fn() }
  })
  subscriptions.set(subscription.requestId, subscription)
  return { subscriptions, subscription }
}

function okResponse(subscriptionId: string): RuntimeRpcResponse<unknown> {
  return {
    ok: true,
    id: 'req-1',
    result: { subscriptionId }
  } as unknown as RuntimeRpcResponse<unknown>
}

describe('closeSharedControlLogicalSubscription — replay-window leak', () => {
  it('sends the unsubscribe when closed after an established subscribe replay completes', () => {
    const { subscriptions, subscription } = makeSubscriptions()
    // First establishment: server assigned a concrete subscription id.
    subscription.sent = true
    subscription.remoteSubscriptionId = 'server-sub-1'

    const request = vi.fn()
    closeSharedControlLogicalSubscription({ subscriptions, subscription, request })

    // Established subscription cleans up immediately by its known id.
    expect(request).toHaveBeenCalledWith('runtime.clientEvents.unsubscribe', {
      subscriptionId: 'server-sub-1'
    })
    expect(subscriptions.size).toBe(0)
  })

  it('does NOT leak a server subscription when close races the replay resubscribe window', () => {
    const { subscriptions, subscription } = makeSubscriptions()
    // Subscription was previously established on the server.
    subscription.sent = true
    subscription.remoteSubscriptionId = 'server-sub-1'

    // Reconnect replay: sent flips false and the old id is cleared right before
    // the resubscribe frame goes out. The server WILL assign a fresh id.
    const sent: SharedControlLogicalSubscription<unknown>[] = []
    replaySharedControlSubscriptions({
      subscriptions,
      send: (s) => {
        sent.push(s)
      },
      tagReplayedResponses: true
    })
    expect(subscription.sent).toBe(false)
    expect(subscription.remoteSubscriptionId).toBeNull()

    // close() arrives during the window: no remoteSubscriptionId yet, so a
    // naive close finishes locally and never unsubscribes — leaking the server
    // subscription that the in-flight resubscribe is about to create.
    const request = vi.fn()
    closeSharedControlLogicalSubscription({ subscriptions, subscription, request })

    // The close must be deferred, not finished with no cleanup.
    expect(subscriptions.size).toBe(1)
    expect(request).not.toHaveBeenCalled()

    // When the resubscribe's ready response arrives with the new server id, the
    // deferred close fires the unsubscribe and only then finishes.
    handleSharedControlLogicalResponse({
      subscriptions,
      subscription,
      response: okResponse('server-sub-2'),
      request
    })

    expect(request).toHaveBeenCalledWith('runtime.clientEvents.unsubscribe', {
      subscriptionId: 'server-sub-2'
    })
    expect(subscriptions.size).toBe(0)
  })

  it('finishes locally without an unsubscribe for a never-sent subscription', () => {
    const { subscriptions, subscription } = makeSubscriptions()
    // Brand new: never sent, no server subscription exists.
    const request = vi.fn()
    closeSharedControlLogicalSubscription({ subscriptions, subscription, request })

    expect(request).not.toHaveBeenCalled()
    expect(subscriptions.size).toBe(0)
  })

  it('finishes a deferred close locally when replay returns an error', () => {
    const { subscriptions, subscription } = makeSubscriptions()
    subscription.sent = true
    subscription.remoteSubscriptionId = 'server-sub-1'
    replaySharedControlSubscriptions({ subscriptions, send: vi.fn(), tagReplayedResponses: true })

    const request = vi.fn()
    closeSharedControlLogicalSubscription({ subscriptions, subscription, request })
    handleSharedControlLogicalResponse({
      subscriptions,
      subscription,
      response: {
        ok: false,
        id: 'req-1',
        error: { code: 'replay_failed', message: 'replay failed' }
      } as RuntimeRpcResponse<unknown>,
      request
    })

    expect(request).not.toHaveBeenCalled()
    expect(subscriptions.size).toBe(0)
  })

  it('does not leave a later close waiting after replay already failed', () => {
    const { subscriptions, subscription } = makeSubscriptions()
    subscription.sent = true
    subscription.remoteSubscriptionId = 'server-sub-1'
    replaySharedControlSubscriptions({ subscriptions, send: vi.fn(), tagReplayedResponses: true })

    handleSharedControlLogicalResponse({
      subscriptions,
      subscription,
      response: {
        ok: false,
        id: 'req-1',
        error: { code: 'replay_failed', message: 'replay failed' }
      } as RuntimeRpcResponse<unknown>,
      request: vi.fn()
    })

    const request = vi.fn()
    closeSharedControlLogicalSubscription({ subscriptions, subscription, request })
    expect(request).not.toHaveBeenCalled()
    expect(subscriptions.size).toBe(0)
  })
})
