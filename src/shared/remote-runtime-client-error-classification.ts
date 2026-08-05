export type RemoteRuntimeClientErrorLike = { code?: string; message: string }

export const RUNTIME_RPC_QUEUE_OVERLOAD_CODE = 'runtime_rpc_queue_overloaded'
export const RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT = 'remote runtime call queue is full'

const RECOVERABLE_CODES = new Set([
  'remote_runtime_unavailable',
  RUNTIME_RPC_QUEUE_OVERLOAD_CODE,
  'runtime_timeout',
  'runtime_unavailable',
  'reconnecting',
  'timeout'
])

const RECOVERABLE_MESSAGE_FRAGMENTS = [
  'could not connect to the remote orca runtime',
  'remote orca runtime closed the connection',
  'remote orca runtime connection closed',
  'remote orca runtime is not connected',
  RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT,
  'remote runtime connection closed',
  'remote runtime subscription closed before it started',
  'remote terminal stream is not connected',
  'timed out waiting for the remote orca runtime'
]

export function isRuntimeRpcQueueOverloadError(error: RemoteRuntimeClientErrorLike): boolean {
  return (
    error.code === RUNTIME_RPC_QUEUE_OVERLOAD_CODE ||
    error.message.toLowerCase().includes(RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT)
  )
}

export function isRecoverableRemoteRuntimeConnectionError(
  error: RemoteRuntimeClientErrorLike
): boolean {
  if (error.code && RECOVERABLE_CODES.has(error.code)) {
    return true
  }
  const message = error.message.toLowerCase()
  return RECOVERABLE_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))
}

export function toRemoteRuntimeClientErrorLike(error: unknown): RemoteRuntimeClientErrorLike {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.message === 'string') {
      return {
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        message: candidate.message
      }
    }
  }
  return { message: String(error) }
}
