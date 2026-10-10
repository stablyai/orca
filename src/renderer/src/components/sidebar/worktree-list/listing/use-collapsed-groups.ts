import { useMemo } from 'react'
import { getWorktreeRevealCollapsedGroupKeys } from '../navigation/worktree-reveal-group-keys'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { PinnedWorktreeDisplayPolicy, WorktreeGroupBy } from '../grouping/row-types'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import { getFolderWorkspaceRevealGroupKeys } from '../navigation/folder-reveal'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

// While the agent send picker targets a workspace, force open every section that hides it.
export function useEffectiveCollapsedGroups(args: {
  hostScopedGroups?: boolean
  collapsedGroups: Set<string>
  agentSendTargetWorktreeId: string | null
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  worktrees: readonly Worktree[]
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
    hostScopedGroups = false,
    agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy,
    worktrees,
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
      worktree: targetWorktree,
      worktrees,
      visibleWorktrees,
      worktreeLineageById,
      repoMap,
      defaultHostId,
      hostScopedGroups,
      collapsedGroups,
      groupBy,
      pinnedDisplayPolicy,
      prCache,
      workspaceStatuses,
      settings,
      projectGroups,
      projectGrouping
    })) {
      next.delete(groupKey)
    }
    return next
  }, [
    agentSendTargetWorktreeId,
    collapsedGroups,
    hostScopedGroups,
    groupBy,
    pinnedDisplayPolicy,
    worktrees,
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
