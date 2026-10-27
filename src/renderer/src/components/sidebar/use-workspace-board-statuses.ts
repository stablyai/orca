import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { mergeHostWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

/** The columns to group cards by: local ones plus each paired host's, so a host's card keeps its column. Edits use the local list. */
export function useWorkspaceBoardStatuses(): readonly WorkspaceStatusDefinition[] {
  const local = useAppStore((s) => s.workspaceStatuses)
  const byHost = useAppStore((s) => s.hostWorkspaceStatuses)
  const removed = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  return useMemo(
    () =>
      mergeHostWorkspaceStatuses(
        local,
        Object.entries(byHost).flatMap(([environmentId, statuses]) =>
          removed.has(environmentId) ? [] : [statuses]
        )
      ),
    [local, byHost, removed]
  )
}
