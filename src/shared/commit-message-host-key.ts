export const LOCAL_COMMIT_MESSAGE_HOST_KEY = 'local'
export const UNKNOWN_COMMIT_MESSAGE_HOST_KEY = 'unknown'
export const RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX = 'runtime:'

export function getCommitMessageModelDiscoveryHostKey(
  connectionId: string | null | undefined
): string {
  if (connectionId === undefined) {
    return UNKNOWN_COMMIT_MESSAGE_HOST_KEY
  }
  return connectionId ? `ssh:${connectionId}` : LOCAL_COMMIT_MESSAGE_HOST_KEY
}

export function getCommitMessageModelDiscoveryHostKeyForScope(
  scope: string | null | undefined
): string {
  if (scope === undefined) {
    return UNKNOWN_COMMIT_MESSAGE_HOST_KEY
  }
  if (!scope) {
    return LOCAL_COMMIT_MESSAGE_HOST_KEY
  }
  if (scope.startsWith(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX)) {
    return scope
  }
  return getCommitMessageModelDiscoveryHostKey(scope)
}
