import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'

export const REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES = 4 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES = 8 * 1024 * 1024 + 64
export const REMOTE_RUNTIME_MAX_SUBSCRIPTIONS = 256
export const REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES = 1024 * 1024
export const REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES = 16 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_PENDING_REQUESTS = 256
export const REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES = 32 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_PREPARED_RPC_BYTES = REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES
export const REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS = REMOTE_RUNTIME_MAX_PENDING_REQUESTS * 2
export const REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES = REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES * 2
export const REMOTE_RUNTIME_MAX_READY_WAITERS =
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS + REMOTE_RUNTIME_MAX_SUBSCRIPTIONS
export const REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES = 8 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES = 4 * 1024

export function serializeRemoteRuntimePayload(value: unknown): string {
  try {
    return stringifyJsonWithinByteLimit(value, REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES).serialized
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RemoteRuntimeClientError(
        'invalid_argument',
        `Remote runtime JSON payload exceeds ${REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES} bytes.`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Remote runtime JSON payload could not be serialized: ${message}`
    )
  }
}

export function measureRemoteRuntimeSubscriptionParams(params: unknown): number {
  if (params === undefined) {
    return 0
  }
  try {
    return stringifyJsonWithinByteLimit(params, REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES)
      .byteLength
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RemoteRuntimeClientError(
        'invalid_argument',
        `Remote runtime subscription parameters exceed ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES} bytes.`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Remote runtime subscription parameters could not be serialized: ${message}`
    )
  }
}

export function serializeRemoteRuntimeRpcRequest(args: {
  requestId: string
  deviceToken: string
  method: string
  params: unknown
}): string {
  return serializeRemoteRuntimePayload({
    id: args.requestId,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params
  })
}

export function retainedRemoteRuntimeJsonStringBytes(value: string): number {
  return value.length * 3
}

export function isRemoteRuntimeBinaryFrameWithinLimit(bytes: Uint8Array<ArrayBufferLike>): boolean {
  return bytes.byteLength <= REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES
}
