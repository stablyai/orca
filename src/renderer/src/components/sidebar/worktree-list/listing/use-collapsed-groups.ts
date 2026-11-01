import { useMemo } from 'react'
import type { WorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import { getWorktreeRevealCollapsedGroupKeys } from '../navigation/worktree-reveal-group-keys'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import { getFolderWorkspaceRevealGroupKeys } from '../navigation/folder-reveal'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

// While the agent send picker targets a workspace, force open every section that hides it.
export function useEffectiveCollapsedGroups(args: {
  occurrencePlan?: WorktreeOccurrencePlan<Worktree>
  hostScopedGroups?: boolean
  collapsedGroups: Set<string>
  agentSendTargetWorktreeId: string | null
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  worktrees: readonly Worktree[]
  visibleWorktrees: readonly Worktree[]
  filterRepoIds?: readonly string[]
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectGroupingModel
  folderWorkspaces: readonly FolderWorkspace[]
  defaultHostId: ExecutionHostId
}): Set<string> {
  const {
    occurrencePlan,
    collapsedGroups,
    hostScopedGroups = false,
    agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy,
    worktrees,
    visibleWorktrees,
    filterRepoIds,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    workspaceStatuses,
    projectGroups,
    projectGrouping,
    folderWorkspaces,
    defaultHostId
  } = args
  return useMemo(() => {
    if (!agentSendTargetWorktreeId) {
      return collapsedGroups
    }
    const targetWorktree = worktreeMap.get(agentSendTargetWorktreeId)
    if (!targetWorktree) {
      // Folder workspaces are absent from worktreeMap but still need picker-driven section reveal.
      const folderKeys = getFolderWorkspaceRevealGroupKeys(
        agentSendTargetWorktreeId,
        folderWorkspaces,
        projectGroups,
        { groupBy, workspaceStatuses, defaultHostId, hostScopedGroups }
      )
      if (folderKeys.length === 0) {
        return collapsedGroups
      }
      const nextForFolder = new Set(collapsedGroups)
      for (const groupKey of folderKeys) {
        nextForFolder.delete(groupKey)
      }
      return nextForFolder
    }
    const next = new Set(collapsedGroups)
    for (const groupKey of getWorktreeRevealCollapsedGroupKeys({
      occurrencePlan,
      worktree: targetWorktree,
      worktrees,
      visibleWorktrees,
      filterRepoIds,
      worktreeLineageById,
      repoMap,
      defaultHostId,
      hostScopedGroups,
      collapsedGroups,
      groupBy,
      pinnedDisplayPolicy,
      prCache,
      workspaceStatuses,
      projectGroups,
      projectGrouping
    })) {
      next.delete(groupKey)
    }
    return next
  }, [
    agentSendTargetWorktreeId,
    occurrencePlan,
    collapsedGroups,
    hostScopedGroups,
    groupBy,
    pinnedDisplayPolicy,
    worktrees,
    visibleWorktrees,
    filterRepoIds,
    prCache,
    projectGroups,
    projectGrouping,
    repoMap,
    workspaceStatuses,
    worktreeLineageById,
    worktreeMap,
    folderWorkspaces,
    defaultHostId
  ])
}
