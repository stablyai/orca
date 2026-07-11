import { randomUUID } from 'node:crypto'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import {
  closeSharedControlLogicalSubscription,
  createSharedControlSubscription,
  sendSharedControlCleanupRequest
} from './remote-runtime-shared-control-subscriptions'
import { finishSharedControlSubscription } from './remote-runtime-shared-control-state'
import type {
  RemoteRuntimeSharedSubscription,
  SharedControlLogicalSubscription,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

export async function startSharedControlSubscription<TResult>(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  method: string
  params: unknown
  callbacks: SharedControlSubscriptionCallbacks<TResult>
  ensureReady: () => Promise<void>
  sendSubscription: (subscription: SharedControlLogicalSubscription<unknown>) => void
  closeSubscription: (requestId: string) => void
  onSubscriptionsEmpty: () => void
}): Promise<RemoteRuntimeSharedSubscription> {
  const requestId = randomUUID()
  const subscription = createSharedControlSubscription({
    requestId,
    method: args.method,
    params: args.params,
    callbacks: args.callbacks
  })
  args.subscriptions.set(requestId, subscription as SharedControlLogicalSubscription<unknown>)
  try {
    await args.ensureReady()
  } catch (error) {
    finishSharedControlSubscription(
      args.subscriptions,
      subscription as SharedControlLogicalSubscription<unknown>,
      false
    )
    if (args.subscriptions.size === 0) {
      args.onSubscriptionsEmpty()
    }
    throw error
  }
  if (args.subscriptions.get(requestId) !== subscription) {
    throw remoteRuntimeUnavailableError('Remote runtime subscription closed before it started.')
  }
  args.sendSubscription(subscription as SharedControlLogicalSubscription<unknown>)
  return {
    requestId,
    close: () => args.closeSubscription(requestId),
    sendBinary: () => false
  }
}

export function closeSharedControlSubscriptionByRequestId(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  requestId: string
  deviceToken: string
  send: (payload: unknown) => boolean
  onSubscriptionsEmpty: () => void
}): void {
  const subscription = args.subscriptions.get(args.requestId)
  if (!subscription) {
    return
  }
  closeSharedControlLogicalSubscription({
    subscriptions: args.subscriptions,
    subscription,
    request: (method, params) =>
      sendSharedControlCleanupRequest({
        deviceToken: args.deviceToken,
        method,
        params,
        send: args.send
      })
  })
  if (args.subscriptions.size === 0) {
    args.onSubscriptionsEmpty()
  }
}
