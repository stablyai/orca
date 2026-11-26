import type { AppState } from '@/store/types'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../shared/worktree/host-qualified-identity'
import { agentTaskGroupHostRow } from './agent-task-group-source'

type GroupStore = {
  getState: () => AppState
  setState: (update: (state: AppState) => Partial<AppState> | AppState) => void
}

const offeredToHost = new Set<string>()

/**
 * Hands groups this device kept before hosts held them to each workspace's host, once per
 * workspace, so every connected device sees them. A host that already has groups keeps its own.
 */
export function moveDeviceAgentTaskGroupsToHosts(store: GroupStore): void {
  const state = store.getState()
  for (const [workspaceKey, groups] of Object.entries(state.agentTaskGroupsByWorkspace)) {
    if (offeredToHost.has(workspaceKey)) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(workspaceKey)
    const executionHostId = getExecutionHostIdFromWorktreeHostIdentity(workspaceKey)
    const row = agentTaskGroupHostRow(state, worktreeId, executionHostId)
    if (!row) {
      // Not listed yet, or a folder workspace: those keep their groups on this device.
      continue
    }
    offeredToHost.add(workspaceKey)
    if (row.agentTaskGroups) {
      continue
    }
    void state
      .updateWorktreeMeta(
        worktreeId,
        { agentTaskGroups: groups },
        executionHostId ? { executionHostId } : undefined
      )
      .then((result) => {
        if (!result.ok) {
          return
        }
        store.setState((s) => {
          if (s.agentTaskGroupsByWorkspace[workspaceKey] !== groups) {
            return s
          }
          const map = { ...s.agentTaskGroupsByWorkspace }
          delete map[workspaceKey]
          return { agentTaskGroupsByWorkspace: map }
        })
      })
  }
}
