import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusVisualMeta
} from '../../workspace-status'
import { isPRGroupKey, PROJECT_GROUP_META, PR_GROUP_META } from './group-keys'
import type { NoticeHostContext } from './host-labels'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels
} from './host-labels'
import type { OrderedGroupEntry, ProjectGroupingIndex } from './project-grouping'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildImportedWorktreesCardRow,
  buildNewExternalWorktreesInboxRow,
  buildPendingCreationRow
} from './row-builders'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  GroupHeaderRow,
  Row,
  WorktreeGroupBy
} from './row-types'
import { orderMainWorktreeFirst } from './section-order'

/** Everything section emission reads that stays fixed for one buildRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
  projectGroupingActive: boolean
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
  projectIndex: ProjectGroupingIndex | null
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  mixedWorktreeHostContextLabels: Map<string, string> | undefined
  noticeHostContextLabelByRepoId: Map<string, NoticeHostContext> | undefined
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  cyclicLineageIds: ReadonlySet<string>
}

export type GroupChildrenAppender = (
  key: string,
  group: OrderedGroupEntry[1],
  groupDepth: number
) => void

export function buildGroupHeader(
  ctx: SectionAppendContext,
  key: string,
  group: OrderedGroupEntry[1],
  renderGroupBy: Exclude<WorktreeGroupBy, 'none'>,
  projectGroupDepth = 0
): GroupHeaderRow {
  const folderPairs = group.folderWorkspaces ?? []
  const sourceKey = group.sourceKey ?? key
  if (renderGroupBy === 'repo') {
    return {
      type: 'header',
      groupKind: group.projectGroup ? 'project-group' : 'repo',
      key,
      label: group.label,
      count: group.items.length + folderPairs.length,
      tone: PROJECT_GROUP_META.tone,
      icon: PROJECT_GROUP_META.icon,
      repo: group.repo,
      projectGroup: group.projectGroup,
      projectGroupDepth
    }
  }
  if (renderGroupBy === 'workspace-status') {
    const workspaceStatus =
      getWorkspaceStatusFromGroupKey(sourceKey, ctx.workspaceStatuses) ??
      ctx.workspaceStatuses[0]?.id ??
      'in-progress'
    const definition = ctx.workspaceStatuses.find((status) => status.id === workspaceStatus)
    const meta = getWorkspaceStatusVisualMeta(definition ?? workspaceStatus)
    return {
      type: 'header',
      groupKind: 'workspace-status',
      key,
      label: definition?.label ?? workspaceStatus,
      count: group.items.length + folderPairs.length,
      tone: meta.tone,
      icon: meta.icon,
      hostWorktreeCounts: getLaneHostWorktreeCounts(
        group.items,
        folderPairs,
        ctx.repoMap,
        ctx.defaultHostId
      ),
      hostWorktreeIds: getLaneHostWorktreeIds(
        group.items,
        folderPairs,
        ctx.repoMap,
        ctx.defaultHostId
      ),
      worktreeIds: group.items.map((worktree) => worktree.id),
      workspaceStatus,
      projectGroupDepth
    }
  }
  const prGroup = sourceKey.replace(/^pr:/, '')
  const meta = PR_GROUP_META[isPRGroupKey(prGroup) ? prGroup : 'in-progress']
  return {
    type: 'header',
    groupKind: 'pr-status',
    key,
    label: meta.label,
    count: group.items.length + folderPairs.length,
    tone: meta.tone,
    icon: meta.icon,
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      group.items,
      folderPairs,
      ctx.repoMap,
      ctx.defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(
      group.items,
      folderPairs,
      ctx.repoMap,
      ctx.defaultHostId
    ),
    worktreeIds: group.items.map((worktree) => worktree.id),
    projectGroupDepth
  }
}

export function appendOrderedGroups(
  ctx: SectionAppendContext,
  groupsToAppend: OrderedGroupEntry[],
  projectGroupDepth = 0,
  appendChildren?: GroupChildrenAppender
): void {
  const {
    result,
    groupBy,
    collapsedGroups,
    repoMap,
    hostLabelById,
    projectIndex,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    mixedWorktreeHostContextLabels,
    lineageById,
    worktreeMap,
    nestLineage,
    cyclicLineageIds
  } = ctx
  if (groupBy === 'none') {
    return
  }
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const folderPairs = group.folderWorkspaces ?? []
    result.push(buildGroupHeader(ctx, key, group, groupBy, projectGroupDepth))
    if (!isCollapsed) {
      if (groupBy === 'repo') {
        const repoIds =
          group.repoIds.size > 0
            ? [...group.repoIds]
            : repo
              ? [repo.id]
              : (group.sourceKey ?? key).startsWith('repo:')
                ? [(group.sourceKey ?? key).slice('repo:'.length)]
                : []
        for (const repoId of repoIds) {
          const candidate = importedWorktreesByRepo.get(repoId)
          if (candidate) {
            result.push(
              buildImportedWorktreesCardRow(
                candidate,
                'repo-group',
                ctx.noticeHostContextLabelByRepoId?.get(repoId)
              )
            )
          }
        }
        for (const repoId of repoIds) {
          const candidate = newExternalWorktreesInboxByRepo.get(repoId)
          if (candidate) {
            result.push(
              buildNewExternalWorktreesInboxRow(
                candidate,
                ctx.noticeHostContextLabelByRepoId?.get(repoId)
              )
            )
          }
        }
        // Why: surface in-progress creates at the top of their own repo so the
        // new workspace appears where it will land, not flashed to the very top
        // of the sidebar.
        for (const repoId of repoIds) {
          for (const creation of pendingByRepo.get(repoId) ?? []) {
            result.push(buildPendingCreationRow(creation, repoMap))
          }
        }
      }
      if (appendChildren) {
        appendChildren(key, group, projectGroupDepth)
        continue
      }
      const items = groupBy === 'repo' ? orderMainWorktreeFirst(group.items) : group.items
      const hostContextLabelByRepoId =
        groupBy === 'repo'
          ? getMixedHostContextLabels(group, repoMap, projectIndex, hostLabelById)
          : undefined
      // Why (STA-4343): repo grouping normally labels by repo, but one repo id can
      // be registered on two hosts — then every row in the group shares a repo id
      // and the per-repo label cannot tell them apart. Fall back to the per-row
      // host labels, which are keyed by host-qualified identity.
      const hostContextLabelByWorktreeIdentity =
        groupBy === 'repo' && hostContextLabelByRepoId ? undefined : mixedWorktreeHostContextLabels
      appendWorktreeRows(result, items, repoMap, lineageById, worktreeMap, {
        nestLineage,
        collapsedGroups,
        groupDepth: projectGroupDepth,
        projectGrouped: ctx.projectGroupingActive,
        sectionKey: key,
        hostContextLabelByRepoId,
        hostContextLabelByWorktreeIdentity,
        cyclicLineageIds
      })
      for (const pair of folderPairs) {
        result.push(buildFolderWorkspaceRow(pair, projectGroupDepth, ctx.projectGroupingActive))
      }
    }
  }
}
