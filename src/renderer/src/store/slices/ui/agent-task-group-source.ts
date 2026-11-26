import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  findFirstIndexedWorktree,
  findIndexedWorktreeOwnerForHost
} from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceAgentTaskGroups } from '../../../../../shared/agent-task-groups/agent-task-groups'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type GroupSourceState = Pick<AppState, 'agentTaskGroupsByWorkspace' | 'worktreesByRepo'>

/**
 * The git workspace row whose host keeps this workspace's task groups, so every device connected
 * to that host shows the same ones. Folder workspaces have no such row and keep groups per device.
 */
export function agentTaskGroupHostRow(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): Worktree | null {
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return null
  }
  const worktreesByRepo = selectWorktreesByRepo(state)
  return (
    (executionHostId
      ? findIndexedWorktreeOwnerForHost(worktreesByRepo, worktreeId, executionHostId)
      : findFirstIndexedWorktree(worktreesByRepo, worktreeId)) ?? null
  )
}

/** The host's groups once it has any; until then this device's own (older hosts, folder workspaces). */
export function selectWorkspaceAgentTaskGroups(
  state: GroupSourceState,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): WorkspaceAgentTaskGroups | undefined {
  const row = agentTaskGroupHostRow(state, worktreeId, executionHostId)
  if (row && row.agentTaskGroups !== undefined) {
    return row.agentTaskGroups ?? undefined
  }
  return state.agentTaskGroupsByWorkspace[
    composeWorktreeHostIdentity(executionHostId ?? 'local', worktreeId)
  ]
}
