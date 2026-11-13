import {
  resolveAgentLaunchHost,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { findIndexedWorktreeOwnerForHost } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

export function projectAgentLaunchDefaultsForWorkspace(
  state: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  executionHostId = resolveAgentLaunchHost(state, workspace).executionHostId
) {
  const hostId = parseExecutionHostId(executionHostId)?.id
  if (!hostId) {
    return undefined
  }
  const worktree = workspace.worktreeId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, workspace.worktreeId, hostId)
    : null
  const repoId =
    worktree?.repoId ??
    workspace.repoId ??
    (workspace.worktreeId ? getRepoIdFromWorktreeId(workspace.worktreeId) : undefined)
  if (!repoId || workspace.kind === 'floating') {
    return undefined
  }
  return findRepoForHost(state.repos ?? [], repoId, { hostId })?.agentLaunchDefaults
}
