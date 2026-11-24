import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  assignTabToAgentTaskGroup,
  createAgentTaskGroup,
  deleteAgentTaskGroup,
  moveAgentTaskGroup,
  renameAgentTaskGroup,
  setAgentTaskGroupCollapsed,
  setAgentTaskGroupFolder,
  setAgentTaskGroupsListCollapsed,
  type AgentTaskGroupsByWorkspace,
  type WorkspaceAgentTaskGroups
} from '../../../../../shared/agent-task-groups/agent-task-groups'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../shared/worktree/host-qualified-identity'
import { agentTaskGroupHostRow, selectWorkspaceAgentTaskGroups } from './agent-task-group-source'

type AgentTaskGroupActions = Pick<
  UISlice,
  | 'agentTaskGroupsByWorkspace'
  | 'agentTaskGroupLaunchChoiceByWorkspace'
  | 'setAgentTaskGroupLaunchChoice'
  | 'createAgentTaskGroup'
  | 'setAgentTaskGroupFolder'
  | 'setAgentTaskGroupsListCollapsed'
  | 'renameAgentTaskGroup'
  | 'deleteAgentTaskGroup'
  | 'moveAgentTaskGroup'
  | 'setAgentTaskGroupCollapsed'
  | 'assignTabToAgentTaskGroup'
>

export function createAgentTaskGroupActions(
  set: UISliceSet,
  get: UISliceGet
): AgentTaskGroupActions {
  const setOnThisDevice = (workspaceKey: string, next: WorkspaceAgentTaskGroups | null): void =>
    set((s) => {
      if (!next && !s.agentTaskGroupsByWorkspace[workspaceKey]) {
        return s
      }
      const map = { ...s.agentTaskGroupsByWorkspace }
      if (next) {
        map[workspaceKey] = next
      } else {
        delete map[workspaceKey]
      }
      return { agentTaskGroupsByWorkspace: map }
    })

  /** Saves the workspace's whole set with its host; true when the update changed anything. */
  const apply = (
    workspaceKey: string,
    update: (state: AgentTaskGroupsByWorkspace) => AgentTaskGroupsByWorkspace
  ): boolean => {
    const state = get()
    const worktreeId = getWorktreeIdFromHostIdentity(workspaceKey)
    const executionHostId = getExecutionHostIdFromWorktreeHostIdentity(workspaceKey)
    const current = selectWorkspaceAgentTaskGroups(state, worktreeId, executionHostId)
    const before: AgentTaskGroupsByWorkspace = current ? { [workspaceKey]: current } : {}
    // Pure updates return the same map for no-ops, so unchanged state never schedules a write.
    const after = update(before)
    if (after === before) {
      return false
    }
    const next = after[workspaceKey] ?? null
    if (!agentTaskGroupHostRow(state, worktreeId, executionHostId)) {
      setOnThisDevice(workspaceKey, next)
      return true
    }
    // The meta update shows the change at once and reverts it itself if the host refuses.
    void state
      .updateWorktreeMeta(
        worktreeId,
        { agentTaskGroups: next },
        executionHostId ? { executionHostId } : undefined
      )
      .then((result) =>
        // The host's copy now stands for this device's; a host too old to keep groups leaves them here.
        setOnThisDevice(workspaceKey, result.ok ? null : next)
      )
    return true
  }

  return {
    agentTaskGroupsByWorkspace: {},
    agentTaskGroupLaunchChoiceByWorkspace: {},
    setAgentTaskGroupLaunchChoice: (workspaceKey, groupId, activeTabId) =>
      set((s) => ({
        agentTaskGroupLaunchChoiceByWorkspace: {
          ...s.agentTaskGroupLaunchChoiceByWorkspace,
          [workspaceKey]: { groupId, activeTabId }
        }
      })),
    createAgentTaskGroup: (workspaceKey, name, folderPath) => {
      const id = createNonSecureContextUuid()
      const created = apply(workspaceKey, (state) =>
        createAgentTaskGroup(state, workspaceKey, {
          id,
          name,
          createdAt: Date.now(),
          folderPath
        })
      )
      return created ? id : null
    },
    setAgentTaskGroupFolder: (workspaceKey, groupId, folderPath) => {
      apply(workspaceKey, (state) =>
        setAgentTaskGroupFolder(state, workspaceKey, groupId, folderPath)
      )
    },
    setAgentTaskGroupsListCollapsed: (workspaceKey, collapsed) => {
      apply(workspaceKey, (state) =>
        setAgentTaskGroupsListCollapsed(state, workspaceKey, collapsed)
      )
    },
    renameAgentTaskGroup: (workspaceKey, groupId, name) => {
      apply(workspaceKey, (state) => renameAgentTaskGroup(state, workspaceKey, groupId, name))
    },
    deleteAgentTaskGroup: (workspaceKey, groupId) => {
      apply(workspaceKey, (state) => deleteAgentTaskGroup(state, workspaceKey, groupId))
    },
    moveAgentTaskGroup: (workspaceKey, groupId, offset) => {
      apply(workspaceKey, (state) => moveAgentTaskGroup(state, workspaceKey, groupId, offset))
    },
    setAgentTaskGroupCollapsed: (workspaceKey, groupId, collapsed) => {
      apply(workspaceKey, (state) =>
        setAgentTaskGroupCollapsed(state, workspaceKey, groupId, collapsed)
      )
    },
    assignTabToAgentTaskGroup: (workspaceKey, tabId, groupId) => {
      apply(workspaceKey, (state) => assignTabToAgentTaskGroup(state, workspaceKey, tabId, groupId))
    }
  }
}
