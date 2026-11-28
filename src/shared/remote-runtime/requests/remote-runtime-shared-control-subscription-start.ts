import { throwIfSignalAborted } from '../../concurrency/abort-signal-reason'
import { randomUUID } from 'node:crypto'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { admitSharedControlSubscription } from '../control/remote-runtime-shared-control-admission'
import { createSharedControlSubscription } from './remote-runtime-shared-control-subscriptions'
import type { RuntimeRpcResponse } from '../rpc/runtime-rpc-envelope'
import type {
  RemoteRuntimeSharedSubscription,
  SharedControlLogicalSubscription,
  SharedControlSubscriptionCallbacks
} from '../control/remote-runtime-shared-control-types'

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
  binaryChannel?: {
    assign: (subscription: SharedControlLogicalSubscription<unknown>) => void
    sendBinary: (
      subscription: SharedControlLogicalSubscription<unknown>,
      bytes: Uint8Array<ArrayBufferLike>
    ) => boolean
    sendRequest: (
      subscription: SharedControlLogicalSubscription<unknown>,
      method: string,
      params: unknown,
      timeoutMs: number
    ) => Promise<RuntimeRpcResponse<unknown>>
  }
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
  const logical = subscription as SharedControlLogicalSubscription<unknown>
  args.binaryChannel?.assign(logical)
  args.subscriptions.set(requestId, logical)
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
  args.sendSubscription(logical)
  const channel = args.binaryChannel
  return {
    requestId,
    close: () => args.closeSubscription(requestId),
    sendBinary: (bytes) => channel?.sendBinary(logical, bytes) ?? false,
    ...(channel
      ? {
          sendRequest: (method: string, params: unknown, timeoutMs: number) =>
            channel.sendRequest(logical, method, params, timeoutMs)
        }
      : {})
  }
}
