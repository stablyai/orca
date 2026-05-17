import type { SshConnectionStatus } from '../../../shared/ssh-types'

export type SelectedRepoSshGate = {
  selectedRepoConnectionId: string | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
}

export function isSshConnectInProgress(status: SshConnectionStatus | null): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
}

export function getSelectedRepoSshGate(input: {
  connectionId: string | null | undefined
  status: SshConnectionStatus | null | undefined
}): SelectedRepoSshGate {
  const selectedRepoConnectionId = input.connectionId ?? null
  const selectedRepoSshStatus = selectedRepoConnectionId ? (input.status ?? null) : null
  return {
    selectedRepoConnectionId,
    selectedRepoSshStatus,
    selectedRepoRequiresConnection:
      selectedRepoConnectionId !== null && selectedRepoSshStatus !== 'connected',
    selectedRepoConnectInProgress: isSshConnectInProgress(selectedRepoSshStatus)
  }
}

export function canUseRepoBackedComposerSources(input: {
  connectionId: string | null | undefined
  status: SshConnectionStatus | null | undefined
}): boolean {
  return !input.connectionId || input.status === 'connected'
}
