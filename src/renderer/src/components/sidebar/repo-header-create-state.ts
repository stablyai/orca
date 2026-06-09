import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getSelectedRepoSshGate } from '../../lib/new-workspace-ssh-gate'
import { translate } from '@/i18n/i18n'

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
      disabled: false,
      tooltip: translate("auto.components.sidebar.repo.header.create.state.62e71f2d5d", "Create workspace for {{value0}}", { value0: input.label }),
      ariaLabel: translate("auto.components.sidebar.repo.header.create.state.62e71f2d5d", "Create workspace for {{value0}}", { value0: input.label }),
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
      tooltip: translate("auto.components.sidebar.repo.header.create.state.6d022563a8", "Reconnect SSH target before creating workspaces"),
      ariaLabel: translate("auto.components.sidebar.repo.header.create.state.3a70acd808", "Reconnect SSH target before creating workspaces for {{value0}}", { value0: input.label }),
      requiresSshReconnect: true
    }
  }

  return {
    disabled: false,
    tooltip: translate("auto.components.sidebar.repo.header.create.state.992cfbc44b", "Create new worktree for {{value0}}", { value0: input.label }),
    ariaLabel: translate("auto.components.sidebar.repo.header.create.state.992cfbc44b", "Create new worktree for {{value0}}", { value0: input.label }),
    requiresSshReconnect: false
  }
}
