import { throwIfSignalAborted } from './abort-signal-reason'
import { randomUUID } from 'node:crypto'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { admitSharedControlSubscription } from './remote-runtime-shared-control-admission'
import { createSharedControlSubscription } from './remote-runtime-shared-control-subscriptions'
import type {
  RemoteRuntimeSharedSubscription,
  SharedControlLogicalSubscription,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

export async function startSharedControlSubscription<TResult>(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  method: string
  params: unknown
  callbacks: SharedControlSubscriptionCallbacks<TResult>
  signal?: AbortSignal
  ensureReady: () => Promise<void>
  sendSubscription: (subscription: SharedControlLogicalSubscription<unknown>) => void
  closeSubscription: (requestId: string) => void
}): Promise<RemoteRuntimeSharedSubscription> {
  throwIfSignalAborted(args.signal)
  const retainedParamsBytes = admitSharedControlSubscription({
    subscriptions: args.subscriptions,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params
  })
  const requestId = randomUUID()
  const subscription = createSharedControlSubscription({
    requestId,
    method: args.method,
    params: args.params,
    retainedParamsBytes,
    callbacks: args.callbacks
  })
  args.subscriptions.set(requestId, subscription as SharedControlLogicalSubscription<unknown>)
  try {
    await args.ensureReady()
    throwIfSignalAborted(args.signal)
  } catch (error) {
    args.closeSubscription(requestId)
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
