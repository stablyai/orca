export const LOCAL_COMMIT_MESSAGE_HOST_KEY = 'local'
export const UNKNOWN_COMMIT_MESSAGE_HOST_KEY = 'unknown'

export function getCommitMessageModelDiscoveryHostKey(
  connectionId: string | null | undefined
): string {
  if (connectionId === undefined) {
    return UNKNOWN_COMMIT_MESSAGE_HOST_KEY
  }
  return connectionId ? `ssh:${connectionId}` : LOCAL_COMMIT_MESSAGE_HOST_KEY
}
