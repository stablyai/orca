import type { AppState } from '@/store/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getHostSectionCollapseKey } from '../../host-section-collapse'
import { isPinnedSectionWorktree } from '../../pinned-section-worktrees'
import {
  getHostScopedWorktreeLineageInputs,
  getWorktreeLineageAncestors
} from '../../worktree-lineage-projection'
import { getWorktreeLineageGroupKey, PINNED_GROUP_KEY } from '../grouping/group-keys'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import type { PinnedWorktreeDisplayPolicy, WorktreeGroupBy } from '../grouping/row-types'
import { getGroupKeysForWorktree } from '../grouping/worktree-group-keys'
import { getPinnedWorktreeRevealCollapsedGroupKeys } from './reveal-ancestors'

export function getWorktreeRevealCollapsedGroupKeys(args: {
  worktree: Worktree
  worktrees: readonly Worktree[]
  visibleWorktrees?: readonly Worktree[]
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  hostScopedGroups: boolean
  collapsedGroups: ReadonlySet<string>
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
}): string[] {
  const hostId = getWorktreeExecutionHostId(
    args.worktree,
    args.repoMap.get(args.worktree.repoId),
    args.defaultHostId
  )
  const hostLineage = getHostScopedWorktreeLineageInputs(
    args.worktrees,
    args.worktreeLineageById,
    hostId
  )
  const keys = [
    `host:${hostId}`,
    ...getWorktreeLineageAncestors(
      args.worktree,
      hostLineage.lineageById,
      hostLineage.worktreeMap
    ).map(getWorktreeLineageGroupKey)
  ]
  const sectionKey = (key: string) =>
    args.hostScopedGroups ? getHostSectionCollapseKey(key, hostId) : key
  if (
    args.pinnedDisplayPolicy === 'single-location' &&
    isPinnedSectionWorktree(
      args.worktree,
      args.visibleWorktrees ?? args.worktrees,
      hostLineage.lineageById,
      hostLineage.worktreeMap
    )
  ) {
    keys.push(
      ...getPinnedWorktreeRevealCollapsedGroupKeys({
        worktree: args.worktree,
        groupKey: sectionKey(PINNED_GROUP_KEY),
        collapsedGroups: args.collapsedGroups,
        inPinnedSection: true
      })
    )
  } else {
    keys.push(
      ...getGroupKeysForWorktree(
        args.groupBy,
        args.worktree,
        args.repoMap,
        args.prCache,
        args.workspaceStatuses,
        args.settings,
        args.projectGroups,
        args.projectGrouping
      ).map(sectionKey)
    )
  }
  return [...new Set(keys)].filter((key) => args.collapsedGroups.has(key))
}
