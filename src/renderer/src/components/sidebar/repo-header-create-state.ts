import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getSelectedRepoSshGate } from '../../lib/new-workspace-ssh-gate'

export type RepoHeaderCreateState = {
  disabled: boolean
  tooltip: string
  ariaLabel: string
  requiresSshReconnect: boolean
}

export function getRepoHeaderCreateState(input: {
  repo: Repo
  label: string
  sshStatus: SshConnectionStatus | null
}): RepoHeaderCreateState {
  if (!isGitRepoKind(input.repo)) {
    return {
      disabled: true,
      tooltip: `${input.label} is opened as a folder`,
      ariaLabel: `${input.label} is opened as a folder`,
      requiresSshReconnect: false
    }
  }

  const sshGate = getSelectedRepoSshGate({
    connectionId: input.repo.connectionId,
    status: input.repo.connectionId ? input.sshStatus : null
  })
  if (sshGate.selectedRepoRequiresConnection) {
    return {
      disabled: true,
      tooltip: 'Reconnect SSH target before creating workspaces',
      ariaLabel: `Reconnect SSH target before creating workspaces for ${input.label}`,
      requiresSshReconnect: true
    }
  }

  return {
    disabled: false,
    tooltip: `Create workspace for ${input.label}`,
    ariaLabel: `Create workspace for ${input.label}`,
    requiresSshReconnect: false
  }
}
