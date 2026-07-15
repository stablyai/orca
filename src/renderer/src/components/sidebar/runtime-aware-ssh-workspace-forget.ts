import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/types'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'
import {
  resolveSshWorkspaceForget,
  type SshWorkspaceForgetResolution
} from './ssh-workspace-forget-resolution'

/** Resolve workspace deletion behavior against the SSH state owned by its execution runtime. */
export function resolveRuntimeAwareSshWorkspaceForget(
  state: AppState,
  repo: Pick<Repo, 'connectionId'> | null,
  worktreeId: string
): SshWorkspaceForgetResolution {
  const sshOwnerEnvironmentId = repo?.connectionId
    ? getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
    : null
  const connectionStatus = repo?.connectionId
    ? selectRuntimeAwareSshStatus(state, sshOwnerEnvironmentId, repo.connectionId)
    : null
  const targetRemoved = repo?.connectionId
    ? selectRuntimeAwareSshTargetRemoved(state, sshOwnerEnvironmentId, repo.connectionId)
    : false

  return resolveSshWorkspaceForget({
    repo,
    sshConnectionStates: state.sshConnectionStates,
    sshTargetLabels: state.sshTargetLabels,
    sshOwnerEnvironmentId,
    ...(sshOwnerEnvironmentId ? { targetConfigured: !targetRemoved, connectionStatus } : {})
  })
}
