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
import type { NoticeHostContext } from './host-labels'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels
} from './host-labels'
import type {
  OrderedGroupEntry,
  ProjectGroupingIndex,
  WorktreeGroupEntry
} from './project-grouping'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildImportedWorktreesCardRow,
  buildNewExternalWorktreesInboxRow,
  buildPendingCreationRow
} from './row-builders'
import type {
  GroupHeaderRow,
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  Row,
  WorktreeGroupBy,
  WorktreeRow
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
  noticeHostContextLabelByRepoId: Map<string, NoticeHostContext> | undefined
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  cyclicLineageIds: ReadonlySet<string>
  /** Group-by-project only: one row per project, expanded only for the active workspace's project. */
  compactProjectRows?: boolean
  activeWorktreeId?: string | null
}

function getSectionRepoIds(key: string, group: WorktreeGroupEntry): string[] {
  if (group.repoIds.size > 0) {
    return [...group.repoIds]
  }
  if (group.repo) {
    return [group.repo.id]
  }
  return key.startsWith('repo:') ? [key.slice('repo:'.length)] : []
}

function appendSectionWorktreeRows(
  ctx: SectionAppendContext,
  target: Row[],
  key: string,
  group: WorktreeGroupEntry,
  projectGroupDepth: number
): void {
  const { groupBy, repoMap, projectIndex, hostLabelById } = ctx
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
    groupBy === 'repo' && hostContextLabelByRepoId ? undefined : ctx.mixedWorktreeHostContextLabels
  appendWorktreeRows(target, items, repoMap, ctx.lineageById, ctx.worktreeMap, {
    nestLineage: ctx.nestLineage,
    collapsedGroups: ctx.collapsedGroups,
    groupDepth: projectGroupDepth,
    sectionKey: key,
    hostContextLabelByRepoId,
    hostContextLabelByWorktreeIdentity,
    cyclicLineageIds: ctx.cyclicLineageIds
  })
}

function hasPendingCreation(ctx: SectionAppendContext, repoIds: readonly string[]): boolean {
  return repoIds.some((repoId) => (ctx.pendingByRepo.get(repoId)?.length ?? 0) > 0)
}

// Why: a single-workspace project reads as that workspace, so the header folds into the card;
// an in-flight create keeps the header so the pending row has a section to land in.
function buildCompactProjectRow(
  ctx: SectionAppendContext,
  key: string,
  group: WorktreeGroupEntry,
  header: GroupHeaderRow,
  repoIds: readonly string[],
  projectGroupDepth: number
): WorktreeRow | null {
  if (!header.repo || group.items.length !== 1 || hasPendingCreation(ctx, repoIds)) {
    return null
  }
  const rows: Row[] = []
  appendSectionWorktreeRows(ctx, rows, key, group, projectGroupDepth)
  const [row] = rows
  if (rows.length !== 1 || row?.type !== 'item') {
    return null
  }
  return { ...row, compactProjectHeader: header }
}

function appendProjectNoticeRows(ctx: SectionAppendContext, repoIds: readonly string[]): void {
  for (const repoId of repoIds) {
    const candidate = ctx.importedWorktreesByRepo.get(repoId)
    if (candidate) {
      ctx.result.push(
        buildImportedWorktreesCardRow(
          candidate,
          'repo-group',
          ctx.noticeHostContextLabelByRepoId?.get(repoId)
        )
      )
    }
  }
  for (const repoId of repoIds) {
    const candidate = ctx.newExternalWorktreesInboxByRepo.get(repoId)
    if (candidate) {
      ctx.result.push(
        buildNewExternalWorktreesInboxRow(
          candidate,
          ctx.noticeHostContextLabelByRepoId?.get(repoId)
        )
      )
    }
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
    defaultHostId,
    pendingByRepo
  } = ctx
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const folderPairs = group.folderWorkspaces ?? []
    const header: GroupHeaderRow =
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
                count: group.items.length + folderPairs.length,
                tone: meta.tone,
                icon: meta.icon,
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoMap,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoMap,
                  defaultHostId
                ),
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
                count: group.items.length + folderPairs.length,
                tone: meta.tone,
                icon: meta.icon,
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoMap,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoMap,
                  defaultHostId
                ),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()

    const repoIds = groupBy === 'repo' ? getSectionRepoIds(key, group) : []
    let showSection = !isCollapsed
    if (groupBy === 'repo' && ctx.compactProjectRows) {
      // Why accordion: only the project holding the active workspace lists its cards.
      header.compactProjectActive =
        ctx.activeWorktreeId != null &&
        group.items.some((worktree) => worktree.id === ctx.activeWorktreeId)
      const compactRow = buildCompactProjectRow(ctx, key, group, header, repoIds, projectGroupDepth)
      if (compactRow) {
        result.push(compactRow)
        if (header.compactProjectActive) {
          appendProjectNoticeRows(ctx, repoIds)
        }
        continue
      }
      header.projectWorktreeIds = group.items.map((worktree) => worktree.id)
      showSection =
        (header.compactProjectActive && !isCollapsed) || hasPendingCreation(ctx, repoIds)
    }
    result.push(header)
    if (showSection) {
      if (groupBy === 'repo') {
        appendProjectNoticeRows(ctx, repoIds)
        // Why: surface in-progress creates at the top of their own repo so the
        // new workspace appears where it will land, not flashed to the very top
        // of the sidebar.
        for (const repoId of repoIds) {
          for (const creation of pendingByRepo.get(repoId) ?? []) {
            result.push(buildPendingCreationRow(creation, repoMap))
          }
        }
      }
      const firstCardIndex = result.length
      appendSectionWorktreeRows(ctx, result, key, group, projectGroupDepth)
      if (header.compactProjectActive !== undefined) {
        for (let index = firstCardIndex; index < result.length; index++) {
          const row = result[index]
          if (row?.type === 'item') {
            result[index] = { ...row, inExpandedCompactProject: true }
          }
        }
      }
      for (const pair of folderPairs) {
        result.push(buildFolderWorkspaceRow(pair, projectGroupDepth))
      }
    }
  }
}
