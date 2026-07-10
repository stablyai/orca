import { randomUUID } from 'node:crypto'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { createSharedControlSubscription } from './remote-runtime-shared-control-subscriptions'
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
