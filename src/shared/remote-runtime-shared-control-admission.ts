import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  measureRemoteRuntimeSubscriptionParams,
  REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTIONS,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

export function admitSharedControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  method: string
  params: unknown
}): number {
  if (args.subscriptions.size >= REMOTE_RUNTIME_MAX_SUBSCRIPTIONS) {
    throw new RemoteRuntimeClientError(
      'remote_runtime_busy',
      'Remote runtime subscription limit reached; close a subscription and retry.'
    )
  }
  const retainedParamsBytes = measureRemoteRuntimeSubscriptionParams(args.params)
  if (
    retainedSubscriptionBytes(args.subscriptions) + retainedParamsBytes >
    REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES
  ) {
    throw new RemoteRuntimeClientError(
      'remote_runtime_busy',
      'Remote runtime subscription memory limit reached; close a subscription and retry.'
    )
  }
  serializeRequest(args)
  return retainedParamsBytes
}

function serializeRequest(args: { deviceToken: string; method: string; params: unknown }): void {
  serializeRemoteRuntimeRpcRequest({
    requestId: '00000000-0000-4000-8000-000000000000',
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params
  })
}

function retainedSubscriptionBytes(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
): number {
  let bytes = 0
  for (const subscription of subscriptions.values()) {
    bytes += subscription.retainedParamsBytes
  }
  return bytes
}
