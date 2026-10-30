import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  selectAllOfferedWorkspaceStatuses,
  selectWorkspaceBoardStatuses,
  selectWorkspaceStatusesForHost,
  type StatusColumnOwner
} from '@/store/host-workspace-status-columns'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'

/** The columns cards group by: local ones plus the paired hosts' columns their own cards use. Edits use the local list. */
export function useWorkspaceBoardStatuses(): readonly WorkspaceStatusDefinition[] {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)
  return useMemo(
    () =>
      selectWorkspaceBoardStatuses({
        workspaceStatuses,
        hostWorkspaceStatuses,
        removedRuntimeEnvironmentIds,
        worktreesByRepo,
        folderWorkspaces
      }),
    [
      workspaceStatuses,
      hostWorkspaceStatuses,
      removedRuntimeEnvironmentIds,
      worktreesByRepo,
      folderWorkspaces
    ]
  )
}

/**
 * A context menu's columns: a paired host's own only when every card is on that host. Each card
 * still resolves against its own host's columns, so a mixed selection compares like with like.
 */
export function useContextWorkspaceStatuses(worktrees: readonly Worktree[]): {
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  statusesForWorktree: (worktree: Worktree) => readonly WorkspaceStatusDefinition[]
} {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const owners = new Set(
    worktrees.map((item) => item.runtimeOwnerEnvironmentId ?? item.hostId ?? 'local')
  )
  const sharedOwner = owners.size === 1 ? (worktrees[0] ?? null) : null
  const statusesForWorktree = useCallback(
    (owner: StatusColumnOwner | null) =>
      selectWorkspaceStatusesForHost(
        { workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds },
        owner
      ),
    [workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds]
  )
  const offered = useMemo(
    () => statusesForWorktree(sharedOwner),
    [statusesForWorktree, sharedOwner]
  )
  return { workspaceStatuses: offered, statusesForWorktree }
}

/** Every column a menu can offer, so task sync finds a host column no card uses yet. */
export function useAllOfferedWorkspaceStatuses(): readonly WorkspaceStatusDefinition[] {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  return useMemo(
    () =>
      selectAllOfferedWorkspaceStatuses({
        workspaceStatuses,
        hostWorkspaceStatuses,
        removedRuntimeEnvironmentIds
      }),
    [workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds]
  )
}
