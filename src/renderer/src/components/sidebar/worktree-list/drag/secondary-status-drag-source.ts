import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../../store/types'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import { getGroupKeysForWorktree } from '../../../../../../shared/sidebar-list/worktree-group-keys'
import type {
  WorktreeGroupBy,
  WorktreeGroupBySecondary
} from '../../../../../../shared/sidebar-list/row-types'
import { createSidebarPRGroupReader } from '../grouping/pr-group-key'

export type SecondaryStatusDragSourceArgs = {
  sourceGroupKey: string | null
  draggingWorktreeId: string | null
  groupBy: WorktreeGroupBy
  groupBySecondary: WorktreeGroupBySecondary
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: Map<string, Repo>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings'] | undefined
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectGroupingModel | undefined
}

export function getSecondaryStatusDragSourceGroupKey(
  args: SecondaryStatusDragSourceArgs
): string | null {
  if (args.groupBySecondary !== 'workspace-status' || !args.sourceGroupKey) {
    return null
  }
  if (args.sourceGroupKey !== PINNED_GROUP_KEY) {
    return args.sourceGroupKey
  }
  const worktree = args.draggingWorktreeId
    ? args.worktreeMap.get(args.draggingWorktreeId)
    : undefined
  if (!worktree) {
    return null
  }
  return (
    getGroupKeysForWorktree(
      args.groupBy,
      worktree,
      args.repoMap,
      createSidebarPRGroupReader(args.repoMap, args.prCache),
      args.workspaceStatuses,
      args.projectGroups,
      args.projectGrouping,
      args.groupBySecondary
    ).at(-1) ?? null
  )
}
