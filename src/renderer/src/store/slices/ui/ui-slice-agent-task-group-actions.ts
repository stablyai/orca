import type { UISlice, UISliceSet } from './ui-slice-contract'
import {
  assignTabToAgentTaskGroup,
  createAgentTaskGroup,
  deleteAgentTaskGroup,
  moveAgentTaskGroup,
  renameAgentTaskGroup,
  setAgentTaskGroupCollapsed,
  setAgentTaskGroupFolder,
  setAgentTaskGroupsListCollapsed,
  type AgentTaskGroupsByWorkspace
} from '../../../../../shared/agent-task-groups/agent-task-groups'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'

type AgentTaskGroupActions = Pick<
  UISlice,
  | 'agentTaskGroupsByWorkspace'
  | 'createAgentTaskGroup'
  | 'setAgentTaskGroupFolder'
  | 'setAgentTaskGroupsListCollapsed'
  | 'renameAgentTaskGroup'
  | 'deleteAgentTaskGroup'
  | 'moveAgentTaskGroup'
  | 'setAgentTaskGroupCollapsed'
  | 'assignTabToAgentTaskGroup'
>

export function createAgentTaskGroupActions(set: UISliceSet): AgentTaskGroupActions {
  // Pure updates return the same map for no-ops, so unchanged state never schedules a write.
  const apply = (update: (state: AgentTaskGroupsByWorkspace) => AgentTaskGroupsByWorkspace) =>
    set((s) => {
      const next = update(s.agentTaskGroupsByWorkspace)
      return next === s.agentTaskGroupsByWorkspace ? s : { agentTaskGroupsByWorkspace: next }
    })
  return {
    agentTaskGroupsByWorkspace: {},
    createAgentTaskGroup: (workspaceKey, name, folderPath) => {
      const id = createNonSecureContextUuid()
      let created: string | null = null
      apply((state) => {
        const next = createAgentTaskGroup(state, workspaceKey, {
          id,
          name,
          createdAt: Date.now(),
          folderPath
        })
        created = next === state ? null : id
        return next
      })
      return created
    },
    setAgentTaskGroupFolder: (workspaceKey, groupId, folderPath) =>
      apply((state) => setAgentTaskGroupFolder(state, workspaceKey, groupId, folderPath)),
    setAgentTaskGroupsListCollapsed: (workspaceKey, collapsed) =>
      apply((state) => setAgentTaskGroupsListCollapsed(state, workspaceKey, collapsed)),
    renameAgentTaskGroup: (workspaceKey, groupId, name) =>
      apply((state) => renameAgentTaskGroup(state, workspaceKey, groupId, name)),
    deleteAgentTaskGroup: (workspaceKey, groupId) =>
      apply((state) => deleteAgentTaskGroup(state, workspaceKey, groupId)),
    moveAgentTaskGroup: (workspaceKey, groupId, offset) =>
      apply((state) => moveAgentTaskGroup(state, workspaceKey, groupId, offset)),
    setAgentTaskGroupCollapsed: (workspaceKey, groupId, collapsed) =>
      apply((state) => setAgentTaskGroupCollapsed(state, workspaceKey, groupId, collapsed)),
    assignTabToAgentTaskGroup: (workspaceKey, tabId, groupId) =>
      apply((state) => assignTabToAgentTaskGroup(state, workspaceKey, tabId, groupId))
  }
}
