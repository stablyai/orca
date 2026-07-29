export type RemoteRuntimeClientErrorLike = { code?: string; message: string }

const RECOVERABLE_CODES = new Set([
  'remote_runtime_unavailable',
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
  'remote runtime connection closed',
  'remote runtime subscription closed before it started',
  'remote terminal stream is not connected',
  'timed out waiting for the remote orca runtime'
]

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
