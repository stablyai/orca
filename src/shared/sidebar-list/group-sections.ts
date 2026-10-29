import type { Repo } from '../repo-types'
import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { getWorkspaceStatusFromGroupKey } from '../workspace-statuses'
import { isPRGroupKey, type PRGroupKey } from './group-keys'
import type { NoticeHostContext } from './host-labels'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels
} from './host-labels'
import type { OrderedGroupEntry } from './worktree-group-entry'
import type { ProjectGroupingIndex } from '../project-section-grouping'
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
  RepoOfWorktree,
  Row,
  WorktreeGroupBy
} from './row-types'

/** Everything section emission reads that stays fixed for one planSidebarRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
  projectGroupingActive: boolean
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  repoMap: Map<string, Repo>
  repoOf: RepoOfWorktree
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
  projectIndex: ProjectGroupingIndex | null
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  mixedWorktreeHostContextLabels: Map<string, string> | undefined
  noticeHostContextLabelByRepoId: Map<string, NoticeHostContext> | undefined
  occurrencePlan: WorktreeOccurrencePlan<Worktree>
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
      icon: { kind: 'project' },
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
    return {
      type: 'header',
      groupKind: 'workspace-status',
      key,
      label: definition?.label ?? workspaceStatus,
      count: group.items.length + folderPairs.length,
      icon: { kind: 'workspace-status', status: workspaceStatus },
      hostWorktreeCounts: getLaneHostWorktreeCounts(
        group.items,
        folderPairs,
        ctx.repoOf,
        ctx.defaultHostId
      ),
      hostWorktreeIds: getLaneHostWorktreeIds(
        group.items,
        folderPairs,
        ctx.repoOf,
        ctx.defaultHostId
      ),
      worktreeIds: group.items.map((worktree) => worktree.id),
      workspaceStatus,
      projectGroupDepth
    }
  }
  const sourcePRGroup = sourceKey.replace(/^pr:/, '')
  const prGroup: PRGroupKey = isPRGroupKey(sourcePRGroup) ? sourcePRGroup : 'in-progress'
  return {
    type: 'header',
    groupKind: 'pr-status',
    key,
    count: group.items.length + folderPairs.length,
    icon: { kind: 'pr-status', prGroup },
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      group.items,
      folderPairs,
      ctx.repoOf,
      ctx.defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(
      group.items,
      folderPairs,
      ctx.repoOf,
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
    repoOf,
    hostLabelById,
    projectIndex,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    mixedWorktreeHostContextLabels,
    occurrencePlan
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
        // Place in-progress creates atop their own repo so the workspace appears where it will land.
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
      const hostContextLabelByRepoId =
        groupBy === 'repo'
          ? getMixedHostContextLabels(group, repoMap, projectIndex, hostLabelById)
          : undefined
      appendWorktreeRows(result, repoOf, occurrencePlan, {
        collapsedGroups,
        groupDepth: projectGroupDepth,
        projectGrouped: ctx.projectGroupingActive,
        sectionKey: key,
        hostContextLabelByRepoId,
        hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels
      })
      for (const pair of folderPairs) {
        result.push(buildFolderWorkspaceRow(pair, projectGroupDepth, ctx.projectGroupingActive))
      }
    }
  }
}
