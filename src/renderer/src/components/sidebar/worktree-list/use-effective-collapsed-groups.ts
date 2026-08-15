import { useMemo } from 'react'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../shared/worktree/lineage-types'
import {
  getGroupKeysForWorktree,
  getLineageGroupKey,
  PINNED_GROUP_KEY,
  type ProjectGroupingModel,
  type WorktreeGroupBy
} from '../worktree-list-groups'
import { getWorktreeLineageAncestors } from '../worktree-lineage-projection'

// While the agent send picker targets a workspace, force open every section that hides it.
export function useEffectiveCollapsedGroups(args: {
  collapsedGroups: Set<string>
  agentSendTargetWorktreeId: string | null
  groupBy: WorktreeGroupBy
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectGroupingModel
}): Set<string> {
  const {
    collapsedGroups,
    agentSendTargetWorktreeId,
    groupBy,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    workspaceStatuses,
    settings,
    projectGroups,
    projectGrouping
  } = args
  return useMemo(() => {
    if (!agentSendTargetWorktreeId) {
      return collapsedGroups
    }
    const targetWorktree = worktreeMap.get(agentSendTargetWorktreeId)
    if (!targetWorktree) {
      return collapsedGroups
    }
    const next = new Set(collapsedGroups)
    if (targetWorktree.isPinned) {
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
    prCache,
    projectGroups,
    projectGrouping,
    repoMap,
    settings,
    workspaceStatuses,
    worktreeLineageById,
    worktreeMap
  ])
}
