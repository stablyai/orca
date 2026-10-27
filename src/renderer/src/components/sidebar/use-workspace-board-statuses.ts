import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { mergeHostWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

type BoardStatusInputs = Pick<AppState, 'workspaceStatuses'> &
  Partial<Pick<AppState, 'hostWorkspaceStatuses' | 'removedRuntimeEnvironmentIds'>>

function boardStatuses(
  local: readonly WorkspaceStatusDefinition[],
  byHost: BoardStatusInputs['hostWorkspaceStatuses'],
  removed: BoardStatusInputs['removedRuntimeEnvironmentIds']
): readonly WorkspaceStatusDefinition[] {
  return mergeHostWorkspaceStatuses(
    local,
    Object.entries(byHost ?? {}).flatMap(([environmentId, statuses]) =>
      removed?.has(environmentId) ? [] : [statuses]
    )
  )
}

/** The columns cards group by: local ones plus each paired host's, so a host's card keeps its column. Edits use the local list. */
export function selectWorkspaceBoardStatuses(
  state: BoardStatusInputs
): readonly WorkspaceStatusDefinition[] {
  return boardStatuses(
    state.workspaceStatuses,
    state.hostWorkspaceStatuses,
    state.removedRuntimeEnvironmentIds
  )
}

export function useWorkspaceBoardStatuses(): readonly WorkspaceStatusDefinition[] {
  const local = useAppStore((s) => s.workspaceStatuses)
  const byHost = useAppStore((s) => s.hostWorkspaceStatuses)
  const removed = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  return useMemo(() => boardStatuses(local, byHost, removed), [local, byHost, removed])
}
