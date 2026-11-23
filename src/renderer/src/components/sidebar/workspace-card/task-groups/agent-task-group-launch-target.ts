import type { AppState } from '@/store/types'
import { findFirstIndexedWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { selectActiveTabForWorktree } from '@/store/slices/tabs/active-tab-selection'
import { structuredAgentSessionTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentTaskGroup } from '../../../../../../shared/agent-task-groups/agent-task-groups'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { agentTaskGroupWorkspaceKey } from './agent-task-group-workspace-key'

const NO_GROUPS: readonly AgentTaskGroup[] = []

export type TaskGroupLaunchTarget = {
  workspaceKey: string
  executionHostId: ExecutionHostId | undefined
  activeTabId: string | null
  groups: readonly AgentTaskGroup[]
  /** Null: the session goes under the branch, outside every group. */
  group: AgentTaskGroup | null
}

/**
 * Where a new session from the tab bar's + belongs: the group picked in that menu while the same
 * tab is in front, otherwise the group of the conversation in front, otherwise the branch.
 */
export function resolveTaskGroupLaunchTarget(
  state: AppState,
  worktreeId: string
): TaskGroupLaunchTarget {
  const executionHostId = findFirstIndexedWorktree(
    selectWorktreesByRepo(state) ?? {},
    worktreeId
  )?.hostId
  const workspaceKey = agentTaskGroupWorkspaceKey(worktreeId, executionHostId)
  const record = state.agentTaskGroupsByWorkspace[workspaceKey]
  const active = selectActiveTabForWorktree(state, worktreeId)
  const activeTabId = active?.id ?? null
  const groups = record?.groups ?? NO_GROUPS
  const choice = state.agentTaskGroupLaunchChoiceByWorkspace[workspaceKey]
  // A conversation row is filed by its terminal id or by its chat's tab or session id.
  const groupId =
    choice && choice.activeTabId === activeTabId
      ? choice.groupId
      : active && record
        ? (record.groupIdByTabId[active.entityId] ??
          record.groupIdByTabId[active.id] ??
          record.groupIdByTabId[structuredAgentSessionTabId(active.entityId)] ??
          null)
        : null
  return {
    workspaceKey,
    executionHostId,
    activeTabId,
    groups,
    group: groups.find((candidate) => candidate.id === groupId) ?? null
  }
}
