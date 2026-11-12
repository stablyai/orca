import type { Repo } from '../repo-types'
import { getRepoHostIdentity } from '../repo-host-identity'
import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { getWorkspaceStatusFromGroupKey } from '../workspace-statuses'
import { ALL_GROUP_KEY, type PRGroupKey } from './group-keys'
import type { NoticeHostContext } from './host-labels'
import {
  getHostWorktreeIds,
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels,
  getProjectHeaderHostRepos
} from './host-labels'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import type { ProjectGroupingIndex } from '../project-section-grouping'
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
} from './row-types'

/** Everything section emission reads that stays fixed for one planSidebarRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  pinnedRepoIds?: ReadonlySet<string>
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
): Pick<GroupHeaderRow, 'hostRepos' | 'pinTargetRepos' | 'hostWorktreeCounts' | 'hostWorktreeIds'> {
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
  const projectRepoIds = new Set(group.repoIds)
  if (group.repo) {
    projectRepoIds.add(group.repo.id)
  }
  const byIdentity = new Map<string, Repo>()
  const addCandidate = (candidate: Repo | undefined): void => {
    if (!candidate || !projectRepoIds.has(candidate.id)) {
      return
    }
    const identity = getRepoHostIdentity(candidate)
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, candidate)
    }
  }
  for (const candidate of ctx.repos ?? []) {
    addCandidate(candidate)
  }
  for (const candidate of hostRepos?.values() ?? []) {
    addCandidate(candidate)
  }
  addCandidate(group.repo)
  for (const repoId of projectRepoIds) {
    addCandidate(ctx.repoMap.get(repoId))
  }
  const pinTargetRepos = byIdentity.size > 0 ? [...byIdentity.values()] : undefined
  if (!hostRepos) {
    return pinTargetRepos ? { pinTargetRepos } : {}
  }
  const hostWorktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
  return {
    hostRepos,
    pinTargetRepos,
    hostWorktreeCounts: hostWorktreeIds
      ? new Map([...hostWorktreeIds].map(([hostId, ids]) => [hostId, ids.length]))
      : undefined,
    hostWorktreeIds
  }
}

export function appendFlatAllWorkspacesSection(args: {
  result: Row[]
  naturalWorktrees: readonly Worktree[]
  renderableFolderWorkspaces: readonly RenderableFolderWorkspace[]
  repoOf: RepoOfWorktree
  defaultHostId: ExecutionHostId
  collapsedGroups: Set<string>
  occurrencePlan: WorktreeOccurrencePlan<Worktree>
  mixedWorktreeHostContextLabels: ReadonlyMap<string, string> | undefined
  folderPairByIdentity: ReadonlyMap<string, RenderableFolderWorkspace> | undefined
}): void {
  if (args.naturalWorktrees.length === 0 && args.renderableFolderWorkspaces.length === 0) {
    return
  }
  args.result.push({
    type: 'header',
    key: ALL_GROUP_KEY,
    count: args.naturalWorktrees.length + args.renderableFolderWorkspaces.length,
    icon: { kind: 'all' },
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      args.naturalWorktrees,
      args.renderableFolderWorkspaces,
      args.repoOf,
      args.defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(
      args.naturalWorktrees,
      args.renderableFolderWorkspaces,
      args.repoOf,
      args.defaultHostId
    ),
    worktreeIds: args.naturalWorktrees.map((worktree) => worktree.id)
  })
  if (!args.collapsedGroups.has(ALL_GROUP_KEY)) {
    appendWorktreeRows(args.result, args.repoOf, args.occurrencePlan, {
      collapsedGroups: args.collapsedGroups,
      groupDepth: 0,
      sectionKey: ALL_GROUP_KEY,
      hostContextLabelByWorktreeIdentity: args.mixedWorktreeHostContextLabels,
      folderPairByIdentity: args.folderPairByIdentity
    })
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
              const prGroup = key.replace(/^pr:/, '') as PRGroupKey
              return {
                type: 'header' as const,
                key,
                count: group.items.length + folderPairs.length,
                icon: { kind: 'pr-status' as const, prGroup },
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
        folderPairByIdentity: ctx.folderPairByIdentity
      })
    }
  }
}
