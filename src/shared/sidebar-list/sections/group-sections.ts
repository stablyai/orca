import type { Repo } from '../../repository/repo-types'
import type { WorktreeOccurrencePlan } from '../lineage/worktree-occurrence-plan'
import type { WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import type { ExecutionHostId } from '../../execution-host/execution-host'
import { getWorkspaceStatusFromGroupKey } from '../../workspace/status/workspace-statuses'
import { PR_GROUP_ORDER, getPRLaneKey } from '../../workspace-view/workspace-pr-groups'
import type { NoticeHostContext } from '../hosts/host-labels'
import {
  getHostWorktreeIds,
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels,
  getProjectHeaderHostRepos
} from '../hosts/host-labels'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import type { ProjectGroupingIndex } from './project-section-grouping'
import {
  appendWorktreeRows,
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
  SidebarHeaderIcon,
  WorktreeGroupBy
} from '../row-types'
import { UNTAGGED_GROUP_KEY } from './tag-groups'

/** Everything section emission reads that stays fixed for one planSidebarRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
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
  folderPairByIdentity?: ReadonlyMap<string, RenderableFolderWorkspace>
}

function getProjectHeaderHostScope(
  ctx: SectionAppendContext,
  group: WorktreeGroupEntry
): Pick<GroupHeaderRow, 'hostRepos' | 'hostWorktreeCounts' | 'hostWorktreeIds'> {
  const hostRepos = getProjectHeaderHostRepos({
    group,
    repoMap: ctx.repoMap,
    repoOf: ctx.repoOf,
    noticeRepoOf: (repoId) =>
      [
        ctx.importedWorktreesByRepo.get(repoId)?.repo,
        ctx.newExternalWorktreesInboxByRepo.get(repoId)?.repo
      ].filter((repo) => repo !== undefined),
    hasPendingCreation: (repoId) => ctx.pendingByRepo.has(repoId),
    defaultHostId: ctx.defaultHostId
  })
  if (!hostRepos) {
    return {}
  }
  const hostWorktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
  return {
    hostRepos,
    hostWorktreeCounts: hostWorktreeIds
      ? new Map([...hostWorktreeIds].map(([hostId, ids]) => [hostId, ids.length]))
      : undefined,
    hostWorktreeIds
  }
}

export function appendOrderedGroups(
  ctx: SectionAppendContext,
  groupsToAppend: OrderedGroupEntry[],
  projectGroupDepth = 0
): void {
  const {
    result,
    groupBy,
    collapsedGroups,
    workspaceStatuses,
    repoMap,
    repoOf,
    defaultHostId,
    hostLabelById,
    projectIndex,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    mixedWorktreeHostContextLabels,
    occurrencePlan
  } = ctx
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const folderPairs = group.folderWorkspaces ?? []
    const header =
      groupBy === 'repo'
        ? {
            type: 'header' as const,
            key,
            label: group.label,
            count: group.items.length,
            icon: { kind: 'project' as const },
            repo,
            projectGroupDepth,
            ...getProjectHeaderHostScope(ctx, group)
          }
        : groupBy === 'workspace-status'
          ? (() => {
              const workspaceStatus =
                getWorkspaceStatusFromGroupKey(key, workspaceStatuses) ??
                workspaceStatuses[0]?.id ??
                'in-progress'
              const definition = workspaceStatuses.find((status) => status.id === workspaceStatus)
              return {
                type: 'header' as const,
                key,
                label: definition?.label ?? workspaceStatus,
                count: group.items.length + folderPairs.length,
                icon: { kind: 'workspace-status' as const, status: workspaceStatus },
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()
          : (() => {
              const icon: SidebarHeaderIcon =
                groupBy !== 'tag'
                  ? {
                      kind: 'pr-status',
                      prGroup:
                        PR_GROUP_ORDER.find((prGroup) => getPRLaneKey(prGroup) === key) ??
                        'in-progress'
                    }
                  : key === UNTAGGED_GROUP_KEY
                    ? { kind: 'untagged' }
                    : { kind: 'tag' }
              return {
                type: 'header' as const,
                key,
                // Why: a tag's spelling is data; Untagged and the PR lanes are named by each client.
                ...(icon.kind === 'tag' ? { label: group.label } : {}),
                count: group.items.length + folderPairs.length,
                icon,
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()

    result.push(header)
    if (!isCollapsed) {
      if (groupBy === 'repo') {
        const repoIds =
          group.repoIds.size > 0
            ? [...group.repoIds]
            : repo
              ? [repo.id]
              : key.startsWith('repo:')
                ? [key.slice('repo:'.length)]
                : []
        for (const repoId of repoIds) {
          const candidate = importedWorktreesByRepo.get(repoId)
          if (candidate) {
            result.push(
              buildImportedWorktreesCardRow(
                candidate,
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
      const hostContextLabelByRepoId =
        groupBy === 'repo'
          ? getMixedHostContextLabels(group, repoMap, projectIndex, hostLabelById)
          : undefined
      appendWorktreeRows(result, repoOf, occurrencePlan, {
        collapsedGroups,
        groupDepth: projectGroupDepth,
        sectionKey: key,
        hostContextLabelByRepoId,
        hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels,
        folderPairByIdentity: ctx.folderPairByIdentity,
        sectionScopedFolderRows: groupBy === 'tag'
      })
    }
  }
}
