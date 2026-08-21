import { useMemo } from 'react'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { PINNED_GROUP_KEY, getLineageGroupKey } from '../grouping/group-keys'
import type { PinnedWorktreeDisplayPolicy, WorktreeGroupBy } from '../grouping/row-types'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import { getGroupKeysForWorktree } from '../grouping/worktree-group-keys'
import { getFolderWorkspaceRevealGroupKeys } from '../navigation/folder-reveal'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { isPinnedSectionWorktree } from '../../pinned-section-worktrees'
import { getWorktreeLineageAncestors } from '../../worktree-lineage-projection'

// While the agent send picker targets a workspace, force open every section that hides it.
export function useEffectiveCollapsedGroups(args: {
  collapsedGroups: Set<string>
  agentSendTargetWorktreeId: string | null
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  visibleWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectGroupingModel
  folderWorkspaces: readonly FolderWorkspace[]
  defaultHostId: ExecutionHostId
}): Set<string> {
  const {
    collapsedGroups,
    agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy,
    visibleWorktrees,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    workspaceStatuses,
    settings,
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
      // Why: folder workspaces are absent from worktreeMap, so without this the
      // agent-send picker could never open the section hiding one (#15362).
      const folderKeys = getFolderWorkspaceRevealGroupKeys(
        agentSendTargetWorktreeId,
        folderWorkspaces,
        projectGroups,
        { groupBy, workspaceStatuses, defaultHostId }
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
    if (
      pinnedDisplayPolicy === 'single-location' &&
      isPinnedSectionWorktree(targetWorktree, visibleWorktrees, worktreeLineageById, worktreeMap)
    ) {
      next.delete(PINNED_GROUP_KEY)
    } else {
      for (const groupKey of getGroupKeysForWorktree(
        groupBy,
        targetWorktree,
        repoMap,
        prCache,
        workspaceStatuses,
        settings,
        projectGroups,
        projectGrouping
      )) {
        next.delete(groupKey)
      }
    }

    for (const parent of getWorktreeLineageAncestors(
      targetWorktree,
      worktreeLineageById,
      worktreeMap
    )) {
      next.delete(getLineageGroupKey(parent.id))
    }
    return next
  }, [
    agentSendTargetWorktreeId,
    collapsedGroups,
    groupBy,
    pinnedDisplayPolicy,
    visibleWorktrees,
    prCache,
    projectGroups,
    projectGrouping,
    repoMap,
    settings,
    workspaceStatuses,
    worktreeLineageById,
    worktreeMap,
    folderWorkspaces,
    defaultHostId
  ])
}
