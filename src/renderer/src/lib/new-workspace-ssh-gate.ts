import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

export type SelectedRepoSshGate = {
  selectedRepoConnectionId: string | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
}

export function isSshConnectInProgress(status: SshConnectionStatus | null): boolean {
  return isConnectingSshStatus(status)
}

export function getSelectedRepoSshGate(input: {
  connectionId: string | null | undefined
  status: SshConnectionStatus | null | undefined
}): SelectedRepoSshGate {
  // Runtime-owned SSH targets are hidden/destroyable plumbing, never user-connectable; stale ephemeral repos must not create dead Connect gates.
  const selectedRepoConnectionId = isRuntimeOwnedSshTargetId(input.connectionId)
    ? null
    : (input.connectionId ?? null)
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
  // A runtime-owned target isn't a user SSH connection, so it never gates repo-backed sources.
  return (
    !input.connectionId ||
    isRuntimeOwnedSshTargetId(input.connectionId) ||
    input.status === 'connected'
  )
}
