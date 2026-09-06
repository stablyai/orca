import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { PINNED_GROUP_KEY, PINNED_GROUP_META } from './group-keys'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  type NoticeHostContext
} from './host-labels'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildImportedWorktreesCardRow
} from './row-builders'
import type { ImportedWorktreesCardCandidate, Row } from './row-types'

export type PinnedGroupEmitOptions = {
  result: Row[]
  /** Pinned git worktrees, already resolved to whole lineage subtrees when nesting. */
  worktrees: Worktree[]
  /** Pinned folder workspaces. They carry no repo, so they take no part in the
   *  repo-anchored imported-worktrees fallback below. */
  folderWorkspaces: readonly RenderableFolderWorkspace[]
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  collapsedGroups: Set<string>
  renderedNaturalAnchorRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  allowImportedFallback: boolean
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  cyclicLineageIds: ReadonlySet<string>
  noticeHostContextLabelByRepoId?: ReadonlyMap<string, NoticeHostContext>
}

/**
 * The Pinned section's rows.
 *
 * Split out of row-builders to keep that file under the line cap; pinned
 * emission has its own ordering and imported-fallback placement rules.
 */
export function emitPinnedGroup(options: PinnedGroupEmitOptions): void {
  const {
    result,
    worktrees,
    folderWorkspaces,
    repoMap,
    defaultHostId,
    collapsedGroups,
    renderedNaturalAnchorRepoIds,
    importedWorktreesByRepo,
    allowImportedFallback,
    lineageById,
    worktreeMap,
    nestLineage,
    cyclicLineageIds,
    noticeHostContextLabelByRepoId
  } = options
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return
  }
  const pinnedRepoOrder: string[] = []
  const seenPinnedRepoIds = new Set<string>()
  for (const worktree of worktrees) {
    if (!seenPinnedRepoIds.has(worktree.repoId)) {
      pinnedRepoOrder.push(worktree.repoId)
      seenPinnedRepoIds.add(worktree.repoId)
    }
  }

  result.push({
    type: 'header',
    key: PINNED_GROUP_KEY,
    label: PINNED_GROUP_META.label,
    count: worktrees.length + folderWorkspaces.length,
    tone: PINNED_GROUP_META.tone,
    icon: PINNED_GROUP_META.icon,
    // Why the lane helpers and not a local tally: a Pinned section holding only
    // folder workspaces still needs a defined host map, or the host sections
    // read the missing key as unscoped and leak the global worktrees in (#15362).
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      worktrees,
      folderWorkspaces,
      repoMap,
      defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(worktrees, folderWorkspaces, repoMap, defaultHostId),
    worktreeIds: worktrees.map((worktree) => worktree.id)
  })
  if (collapsedGroups.has(PINNED_GROUP_KEY)) {
    for (const repoId of pinnedRepoOrder) {
      const candidate = importedWorktreesByRepo.get(repoId)
      if (allowImportedFallback && candidate && !renderedNaturalAnchorRepoIds.has(repoId)) {
        result.push(
          buildImportedWorktreesCardRow(
            candidate,
            'pinned-fallback',
            noticeHostContextLabelByRepoId?.get(repoId)
          )
        )
      }
    }
    return
  }

  const firstItemIndex = result.length
  appendWorktreeRows(result, worktrees, repoMap, lineageById, worktreeMap, {
    nestLineage,
    collapsedGroups,
    groupDepth: 0,
    sectionKey: PINNED_GROUP_KEY,
    cyclicLineageIds
  })
  for (const pair of [...folderWorkspaces].sort((left, right) =>
    compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
  )) {
    result.push(buildFolderWorkspaceRow(pair, PINNED_GROUP_KEY, 0))
  }
  if (!allowImportedFallback) {
    return
  }
  // Why: imported fallback sits after the last row of that repo; splice from the
  // end so earlier inserts do not shift later targets.
  const lastResultIndexByRepoId = new Map<string, number>()
  for (let index = firstItemIndex; index < result.length; index++) {
    const row = result[index]
    if (row?.type === 'item') {
      lastResultIndexByRepoId.set(row.worktree.repoId, index)
    }
  }
  const inserts = [...lastResultIndexByRepoId.entries()].sort((left, right) => right[1] - left[1])
  for (const [repoId, index] of inserts) {
    const candidate = importedWorktreesByRepo.get(repoId)
    if (candidate && !renderedNaturalAnchorRepoIds.has(repoId)) {
      result.splice(
        index + 1,
        0,
        buildImportedWorktreesCardRow(
          candidate,
          'pinned-fallback',
          noticeHostContextLabelByRepoId?.get(repoId)
        )
      )
    }
  }
}
