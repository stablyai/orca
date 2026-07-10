import { randomUUID } from 'node:crypto'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { getCleanupRequest, getSubscriptionId } from './remote-runtime-shared-control-protocol'
import {
  finishSharedControlSubscription,
  handleSharedControlSubscriptionResponse
} from './remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

export function createSharedControlSubscription<TResult>(args: {
  requestId: string
  method: string
  params: unknown
  callbacks: SharedControlSubscriptionCallbacks<TResult>
}): SharedControlLogicalSubscription<TResult> {
  return {
    requestId: args.requestId,
    method: args.method,
    params: args.params,
    callbacks: args.callbacks,
    sent: false,
    closed: false,
    closeAfterReady: false,
    remoteSubscriptionId: null
  }
}

export function handleSharedControlLogicalResponse(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
  response: RuntimeRpcResponse<unknown>
  request: (method: string, params: unknown) => void
}): void {
  if (!args.subscription.closeAfterReady) {
    handleSharedControlSubscriptionResponse(args.subscriptions, args.subscription, args.response)
    return
  }
  if (args.response.ok) {
    const subscriptionId = getSubscriptionId(args.response.result)
    if (subscriptionId) {
      args.subscription.remoteSubscriptionId = subscriptionId
    }
    const cleanup = getCleanupRequest(args.subscription)
    if (cleanup) {
      args.request(cleanup.method, cleanup.params)
    }
  }
  finishSharedControlSubscription(args.subscriptions, args.subscription, false)
}

export function closeSharedControlLogicalSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
  request: (method: string, params: unknown) => void
}): void {
  const cleanup = getCleanupRequest(args.subscription)
  if (cleanup) {
    finishSharedControlSubscription(args.subscriptions, args.subscription, false)
    args.request(cleanup.method, cleanup.params)
    return
  }
  if (
    (args.subscription.sent || args.subscription.awaitingResubscribe) &&
    cleanupNeedsRemoteSubscriptionId(args.subscription.method)
  ) {
    // Why: id-scoped server subscriptions can only be cleaned up after the
    // server returns its concrete subscription id in the ready response. This
    // also covers the reconnect replay window (sent===false, id cleared) where
    // a resubscribe is in flight — finishing locally there would leak it.
    args.subscription.closeAfterReady = true
    return
  }
  finishSharedControlSubscription(args.subscriptions, args.subscription, false)
}

export function sendSharedControlCleanupRequest(args: {
  deviceToken: string
  method: string
  params: unknown
  send: (payload: unknown) => boolean
}): void {
  // Why: cleanup is best-effort and often runs during teardown; send it
  // synchronously so close() cannot race the async request path.
  args.send({
    id: randomUUID(),
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params
  })
}

export function replaySharedControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  send: (subscription: SharedControlLogicalSubscription<unknown>) => void
  // Why: true only for a reconnect of a previously-ready connection; first
  // connects deliver their initial snapshot through the normal gated path.
  tagReplayedResponses?: boolean
}): void {
  for (const subscription of args.subscriptions.values()) {
    if (subscription.closeAfterReady) {
      continue
    }
    subscription.sent = false
    subscription.remoteSubscriptionId = null
    // Why: mark the id-less window so a close() racing this resubscribe defers
    // to closeAfterReady instead of finishing locally and leaking the server
    // subscription the resubscribe is about to create.
    subscription.awaitingResubscribe = true
    if (args.tagReplayedResponses) {
      subscription.pendingReplayTag = true
    }
    args.send(subscription)
  }
}

export function finishCloseAfterReadySubscriptions(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
): void {
  for (const subscription of Array.from(subscriptions.values())) {
    if (subscription.closeAfterReady) {
      finishSharedControlSubscription(subscriptions, subscription, false)
    }
  }
}

function cleanupNeedsRemoteSubscriptionId(method: string): boolean {
  return (
    method === 'accounts.subscribe' ||
    method === 'notifications.subscribe' ||
    method === 'runtime.clientEvents.subscribe' ||
    method === 'files.watch'
  )
}
