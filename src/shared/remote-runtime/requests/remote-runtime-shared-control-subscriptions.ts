import { randomUUID } from 'node:crypto'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import {
  getCleanupRequest,
  getSubscriptionId
} from '../control/remote-runtime-shared-control-protocol'
import {
  finishSharedControlSubscription,
  handleSharedControlSubscriptionResponse
} from '../control/remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlSubscriptionCallbacks
} from '../control/remote-runtime-shared-control-types'

export function createSharedControlSubscription<TResult>(args: {
  requestId: string
  method: string
  params: unknown
  retainedParamsBytes: number
  callbacks: SharedControlSubscriptionCallbacks<TResult>
}): SharedControlLogicalSubscription<TResult> {
  return {
    requestId: args.requestId,
    method: args.method,
    params: args.params,
    retainedParamsBytes: args.retainedParamsBytes,
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
  subscription?: SharedControlLogicalSubscription<unknown>
  request: (method: string, params: unknown) => void
}): void {
  if (!args.subscription) {
    return
  }
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
    // Wait for the server ID, including during reconnect replay, or leak the in-flight subscription.
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
}): string | null {
  // Send cleanup synchronously so socket close cannot race an async request.
  const requestId = randomUUID()
  const sent = args.send({
    id: requestId,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params
  })
  return sent ? requestId : null
}

export function replaySharedControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  send: (subscription: SharedControlLogicalSubscription<unknown>) => void
  // Only reconnects tag replay; first connects use normal snapshot gates.
  tagReplayedResponses?: boolean
}): void {
  for (const subscription of args.subscriptions.values()) {
    if (subscription.closeAfterReady) {
      continue
    }
    subscription.sent = false
    subscription.remoteSubscriptionId = null
    // Defer a racing close until the replay response supplies the new server ID.
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
