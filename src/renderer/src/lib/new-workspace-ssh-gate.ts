import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
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
  // Why: a runtime-owned (per-workspace-env) SSH target is hidden plumbing the user can't connect
  // to; once its workspace is gone the target is destroyed. Never let it drive a "Connect" gate —
  // otherwise a stale ephemeral repo surfaces a dead connect card in the composer.
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
