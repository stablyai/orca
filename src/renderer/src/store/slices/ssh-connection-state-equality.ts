import type { SshConnectionState } from '../../../../shared/ssh-types'

export function sshConnectionStatesEqual(
  a: SshConnectionState | undefined,
  b: SshConnectionState
): boolean {
  return (
    a?.targetId === b.targetId &&
    a?.status === b.status &&
    a?.error === b.error &&
    a?.reconnectAttempt === b.reconnectAttempt &&
    a?.providerEpoch === b.providerEpoch &&
    a?.connectionGeneration === b.connectionGeneration &&
    a?.supportsFolderDownload === b.supportsFolderDownload &&
    a?.remotePlatform === b.remotePlatform &&
    // Why: a connect can end on the same status and epoch it set up under, changing only these.
    JSON.stringify(a?.managedServer ?? null) === JSON.stringify(b.managedServer ?? null) &&
    JSON.stringify(a?.plainSsh ?? null) === JSON.stringify(b.plainSsh ?? null)
  )
}
