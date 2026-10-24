import type { AppState } from '@/store/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getHostSectionCollapseKey } from '../../../../../../shared/sidebar-list/host-section-collapse'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/group-keys'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import type { WorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { createSidebarPRGroupReader } from '../grouping/pr-group-key'

export function getWorktreeRevealCollapsedGroupKeys(args: {
  occurrencePlan?: WorktreeOccurrencePlan<Worktree>
  worktree: Worktree
  worktrees: readonly Worktree[]
  visibleWorktrees?: readonly Worktree[]
  filterRepoIds?: readonly string[]
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  hostScopedGroups: boolean
  collapsedGroups: ReadonlySet<string>
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
}): string[] {
  const hostId = getWorktreeExecutionHostId(
    args.worktree,
    args.repoMap.get(args.worktree.repoId),
    args.defaultHostId
  )
  const plan =
    args.occurrencePlan ??
    planSidebarRows({
      groupBy: args.groupBy,
      worktrees: [...(args.visibleWorktrees ?? args.worktrees)],
      repoMap: args.repoMap,
      prGroupOf: createSidebarPRGroupReader(args.repoMap, args.prCache),
      workspaceStatuses: args.workspaceStatuses,
      projectOrderBy: 'manual',
      lineageById: { ...args.worktreeLineageById },
      worktreeMap: new Map(args.worktrees.map((row) => [row.id, row])),
      nestLineage: true,
      projectGroups: args.projectGroups,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      projectGrouping: args.projectGrouping,
      folderWorkspaces: [],
      defaultHostId: args.defaultHostId,
      pinnedDisplayPolicy: args.pinnedDisplayPolicy,
      filterRepoIds: args.filterRepoIds ?? []
    }).occurrencePlan
  const occurrence = plan.preferredByIdentity.get(getWorktreeHostIdentity(args.worktree))
  if (!occurrence) {
    return []
  }
  const keys = [`host:${hostId}`]
  let ancestor = occurrence.parent
  while (ancestor) {
    keys.push(getWorktreeLineageGroupKey(ancestor.row))
    ancestor = ancestor.parent
  }
  let path: typeof occurrence.sectionPath | undefined = occurrence.sectionPath
  while (path) {
    keys.push(args.hostScopedGroups ? getHostSectionCollapseKey(path.key, hostId) : path.key)
    path = path.parent
  }
  return [...new Set(keys)].filter((key) => args.collapsedGroups.has(key))
}
