import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import {
  getRuntimeSshAccess,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { resolveOwner, type WorkspaceOwnerRef } from './resolve-owner'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

type EditorSshTargetState = Omit<WorktreeOperationRouteState, 'runtimeEnvironments'> & {
  runtimeEnvironments?: readonly Pick<
    PublicKnownRuntimeEnvironment,
    'id' | 'orcadDeployment' | 'sshAccess'
  >[]
}

export type WorkspaceEditorSshHost = { environmentId: string; sshTargetId: string }

/**
 * The SSH host an editor reaches a server-owned workspace through: the host the server runs on,
 * and only when the workspace's files sit on that machine rather than behind one of its own SSH hosts.
 */
export function getWorkspaceEditorSshHost(
  state: EditorSshTargetState,
  ref: WorkspaceOwnerRef | null | undefined
): WorkspaceEditorSshHost | null {
  if (!ref?.workspaceId) {
    return null
  }
  const match = resolveOwner(state, ref)
  if (
    match.kind !== 'resolved' ||
    match.owner.endpoint.kind !== 'environment' ||
    match.owner.at !== 'local'
  ) {
    return null
  }
  const { environmentId } = match.owner.endpoint
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
  const targetId = environment ? getRuntimeSshAccess(environment)?.sshTargetId : undefined
  // Why: an ephemeral VM's target is an implementation detail, not a host the user's editor knows.
  return targetId && !isRuntimeOwnedSshTargetId(targetId)
    ? { environmentId, sshTargetId: targetId }
    : null
}
