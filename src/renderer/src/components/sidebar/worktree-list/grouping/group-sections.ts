import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusVisualMeta
} from '../../workspace-status'
import { PROJECT_GROUP_META, PR_GROUP_META } from './group-keys'
import type { PRGroupKey } from './group-keys'
import { getHostWorktreeCounts, getHostWorktreeIds, getMixedHostContextLabels } from './host-labels'
import type { OrderedGroupEntry, ProjectGroupingIndex } from './project-grouping'
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
  Row,
  WorktreeGroupBy
} from './row-types'
import { orderMainWorktreeFirst } from './section-order'

/** Everything section emission reads that stays fixed for one buildRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
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
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  cyclicLineageIds: ReadonlySet<string>
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
    defaultHostId,
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
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const header =
      groupBy === 'repo'
        ? {
            type: 'header' as const,
            key,
            label: group.label,
            count: group.items.length,
            tone: PROJECT_GROUP_META.tone,
            icon: PROJECT_GROUP_META.icon,
            repo,
            projectGroupDepth
          }
        : groupBy === 'workspace-status'
          ? (() => {
              const workspaceStatus =
                getWorkspaceStatusFromGroupKey(key, workspaceStatuses) ??
                workspaceStatuses[0]?.id ??
                'in-progress'
              const definition = workspaceStatuses.find((status) => status.id === workspaceStatus)
              const meta = getWorkspaceStatusVisualMeta(definition ?? workspaceStatus)
              return {
                type: 'header' as const,
                key,
                label: definition?.label ?? workspaceStatus,
                count: group.items.length,
                tone: meta.tone,
                icon: meta.icon,
                hostWorktreeCounts: getHostWorktreeCounts(group.items, repoMap, defaultHostId),
                hostWorktreeIds: getHostWorktreeIds(group.items, repoMap, defaultHostId),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()
          : (() => {
              const prGroup = key.replace(/^pr:/, '') as PRGroupKey
              const meta = PR_GROUP_META[prGroup]
              return {
                type: 'header' as const,
                key,
                label: meta.label,
                count: group.items.length,
                tone: meta.tone,
                icon: meta.icon,
                hostWorktreeCounts: getHostWorktreeCounts(group.items, repoMap, defaultHostId),
                hostWorktreeIds: getHostWorktreeIds(group.items, repoMap, defaultHostId),
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
            result.push(buildImportedWorktreesCardRow(candidate, 'repo-group'))
          }
        }
        for (const repoId of repoIds) {
          const candidate = newExternalWorktreesInboxByRepo.get(repoId)
          if (candidate) {
            result.push(buildNewExternalWorktreesInboxRow(candidate))
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
        sectionKey: key,
        hostContextLabelByRepoId,
        hostContextLabelByWorktreeIdentity,
        cyclicLineageIds
      })
    }
  }
}
