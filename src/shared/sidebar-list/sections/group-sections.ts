import type { Repo } from '../../repository/repo-types'
import type { WorktreeOccurrencePlan } from '../lineage/worktree-occurrence-plan'
import type { WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import type { ExecutionHostId } from '../../execution-host/execution-host'
import { getWorkspaceStatusFromGroupKey } from '../../workspace/status/workspace-statuses'
import type { PRGroupKey } from '../../workspace-view/workspace-pr-groups'
import type { NoticeHostContext } from '../hosts/host-labels'
import {
  getHostWorktreeIds,
  getLaneHostWorktreeScope,
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
  WorktreeGroupBy
} from '../row-types'

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

const EMPTY_REPOS: readonly Repo[] = []

function getProjectHeaderHostScope(
  ctx: SectionAppendContext,
  group: WorktreeGroupEntry
): Pick<GroupHeaderRow, 'hostRepos' | 'hostWorktreeCounts' | 'hostWorktreeIds'> | undefined {
  const hasNoticeRepos =
    ctx.importedWorktreesByRepo.size > 0 || ctx.newExternalWorktreesInboxByRepo.size > 0
  const hostRepos = getProjectHeaderHostRepos({
    group,
    repoMap: ctx.repoMap,
    repoOf: ctx.repoOf,
    noticeRepoOf: hasNoticeRepos
      ? (repoId) => {
          const imported = ctx.importedWorktreesByRepo.get(repoId)?.repo
          const inbox = ctx.newExternalWorktreesInboxByRepo.get(repoId)?.repo
          if (imported && inbox) {
            return [imported, inbox]
          }
          if (imported) {
            return [imported]
          }
          return inbox ? [inbox] : EMPTY_REPOS
        }
      : () => EMPTY_REPOS,
    hasPendingCreation:
      ctx.pendingByRepo.size > 0 ? (repoId) => ctx.pendingByRepo.has(repoId) : () => false,
    defaultHostId: ctx.defaultHostId
  })
  if (!hostRepos) {
    return undefined
  }
  const hostWorktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
  let hostWorktreeCounts: Map<ExecutionHostId, number> | undefined
  if (hostWorktreeIds) {
    hostWorktreeCounts = new Map()
    for (const [hostId, ids] of hostWorktreeIds) {
      hostWorktreeCounts.set(hostId, ids.length)
    }
  }
  return {
    hostRepos,
    hostWorktreeCounts,
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
  const hasNoticesOrPending =
    importedWorktreesByRepo.size > 0 ||
    newExternalWorktreesInboxByRepo.size > 0 ||
    pendingByRepo.size > 0
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const folderPairs = group.folderWorkspaces ?? []
    let header: GroupHeaderRow
    if (groupBy === 'repo') {
      const hostScope = getProjectHeaderHostScope(ctx, group)
      header = {
        type: 'header',
        key,
        label: group.label,
        count: group.items.length,
        icon: { kind: 'project' },
        repo,
        projectGroupDepth
      }
      if (hostScope) {
        header.hostRepos = hostScope.hostRepos
        header.hostWorktreeCounts = hostScope.hostWorktreeCounts
        header.hostWorktreeIds = hostScope.hostWorktreeIds
      }
    } else if (groupBy === 'workspace-status') {
      const workspaceStatus =
        getWorkspaceStatusFromGroupKey(key, workspaceStatuses) ??
        workspaceStatuses[0]?.id ??
        'in-progress'
      const definition = workspaceStatuses.find((status) => status.id === workspaceStatus)
      header = {
        type: 'header',
        key,
        label: definition?.label ?? workspaceStatus,
        count: group.items.length + folderPairs.length,
        icon: { kind: 'workspace-status', status: workspaceStatus },
        ...getLaneHostWorktreeScope(group.items, folderPairs, repoOf, defaultHostId),
        worktreeIds: group.items.map((worktree) => worktree.id)
      }
    } else {
      const prGroup = key.replace(/^pr:/, '') as PRGroupKey
      header = {
        type: 'header',
        key,
        count: group.items.length + folderPairs.length,
        icon: { kind: 'pr-status', prGroup },
        ...getLaneHostWorktreeScope(group.items, folderPairs, repoOf, defaultHostId),
        worktreeIds: group.items.map((worktree) => worktree.id)
      }
    }

    result.push(header)
    if (!isCollapsed) {
      if (groupBy === 'repo' && hasNoticesOrPending) {
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
        folderPairByIdentity: ctx.folderPairByIdentity
      })
    }
  }
}
