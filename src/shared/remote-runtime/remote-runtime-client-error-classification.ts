export type RemoteRuntimeClientErrorLike = { code?: string; message: string }

export const RUNTIME_RPC_QUEUE_OVERLOAD_CODE = 'runtime_rpc_queue_overloaded'
export const RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT = 'remote runtime call queue is full'

// Export for the transport-error corpus guard’s code/message agreement check.
export const RECOVERABLE_CODES: ReadonlySet<string> = new Set([
  'remote_runtime_unavailable',
  // A client-side admission cap that frees as pending work settles; fatal would dead-end panes.
  'remote_runtime_busy',
  RUNTIME_RPC_QUEUE_OVERLOAD_CODE,
  'runtime_timeout',
  'runtime_unavailable',
  'reconnecting',
  'timeout'
])

export const RECOVERABLE_MESSAGE_FRAGMENTS: readonly string[] = [
  'could not connect to the remote orca runtime',
  'remote orca runtime closed the connection',
  'remote orca runtime connection closed',
  'remote orca runtime is not connected',
  RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT,
  'remote runtime connection closed',
  // remote_runtime_busy wording, for when IPC strips the code.
  'remote runtime connection wait limit reached',
  'remote runtime request limit reached',
  'remote runtime subscription limit reached',
  'remote runtime subscription memory limit reached',
  'remote runtime subscription closed before it started',
  'remote terminal stream is not connected',
  'timed out waiting for the remote orca runtime'
]

export function isRuntimeRpcQueueOverloadError(error: RemoteRuntimeClientErrorLike): boolean {
  if (error.code) {
    return error.code === RUNTIME_RPC_QUEUE_OVERLOAD_CODE
  }
  return error.message.toLowerCase().includes(RUNTIME_RPC_QUEUE_OVERLOAD_MESSAGE_FRAGMENT)
}

export function isRecoverableRemoteRuntimeConnectionError(
  error: RemoteRuntimeClientErrorLike
): boolean {
  if (error.code) {
    return RECOVERABLE_CODES.has(error.code)
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
