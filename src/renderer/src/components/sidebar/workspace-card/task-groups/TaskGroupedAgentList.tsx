import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { useAgentPresentation } from '../activity/useWorktreeAgentRows'
import type { WorkspaceAgentTaskGroups } from '../../../../../../shared/agent-task-groups/agent-task-groups'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { agentTaskGroupWorkspaceKey } from './agent-task-group-workspace-key'

export { AGENT_ROW_TAB_ID_ATTR } from './agent-task-group-workspace-key'
import { AgentTaskGroupSection } from './AgentTaskGroupSection'

type GroupedRoots = { ungrouped: string[]; byGroup: Map<string, string[]> }
type BranchesComponent<Context> = React.ComponentType<{
  keysToRender: readonly string[]
  context: Context
  timerActive: boolean
  root?: boolean
}>

const EMPTY_KEYS: readonly string[] = []

export function useHasAgentTaskGroups(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  return useAppStore(
    (s) =>
      (s.agentTaskGroupsByWorkspace[agentTaskGroupWorkspaceKey(worktreeId, executionHostId)]?.groups
        .length ?? 0) > 0
  )
}

/** Root rows split by their conversation's task group; null keeps the ungrouped card layout. */
export function useTaskGroupedRoots(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  roots: readonly string[]
): { groups: WorkspaceAgentTaskGroups; grouped: GroupedRoots } | null {
  const taskGroups = useAppStore(
    (s) => s.agentTaskGroupsByWorkspace[agentTaskGroupWorkspaceKey(worktreeId, executionHostId)]
  )
  // A pane's tab never changes, so the roots channel covers it; the joined string keeps snapshots stable.
  const rootTabIds = useAgentPresentation(
    `roots\0${worktreeId}`,
    useCallback((p) => roots.map((key) => p.row(key)?.tab.id ?? '').join('\n'), [roots])
  )
  return useMemo(() => {
    if (!taskGroups) {
      return null
    }
    const tabIds = rootTabIds.split('\n')
    const byGroup = new Map<string, string[]>(taskGroups.groups.map((group) => [group.id, []]))
    const ungrouped: string[] = []
    roots.forEach((key, index) => {
      const groupId = taskGroups.groupIdByTabId[tabIds[index] ?? '']
      ;((groupId ? byGroup.get(groupId) : undefined) ?? ungrouped).push(key)
    })
    return { groups: taskGroups, grouped: { ungrouped, byGroup } }
  }, [rootTabIds, roots, taskGroups])
}

/** Ungrouped conversations keep their usual place; each task group follows as a foldable section. */
export function TaskGroupedAgentList<Context>({
  worktreeId,
  executionHostId,
  taskGroups,
  context,
  Branches
}: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  taskGroups: NonNullable<ReturnType<typeof useTaskGroupedRoots>>
  context: Context
  Branches: BranchesComponent<Context>
}): React.JSX.Element {
  const { groups, grouped } = taskGroups
  const renderBranches = (keys: readonly string[], timerActive: boolean) => (
    <Branches keysToRender={keys} context={context} timerActive={timerActive} root />
  )
  const workspaceKey = agentTaskGroupWorkspaceKey(worktreeId, executionHostId)
  return (
    <>
      {grouped.ungrouped.length > 0 ? renderBranches(grouped.ungrouped, true) : null}
      {groups.groups.map((group, index) => {
        const keys = grouped.byGroup.get(group.id) ?? EMPTY_KEYS
        return (
          <AgentTaskGroupSection
            key={group.id}
            group={group}
            index={index}
            groupCount={groups.groups.length}
            workspaceKey={workspaceKey}
            worktreeId={worktreeId}
            executionHostId={executionHostId}
            conversationCount={keys.length}
          >
            {renderBranches(keys, !group.collapsed)}
          </AgentTaskGroupSection>
        )
      })}
    </>
  )
}
