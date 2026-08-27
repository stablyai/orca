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

/**
 * The Pinned section's rows.
 *
 * Split out of row-builders to keep that file under the line cap; pinned
 * emission has its own ordering and imported-fallback placement rules.
 */
export function emitPinnedGroup(
  pinnedSectionWorktrees: Worktree[],
  pinnedFolderWorkspaces: readonly RenderableFolderWorkspace[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId,
  collapsedGroups: Set<string>,
  renderedNaturalAnchorRepoIds: ReadonlySet<string>,
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>,
  allowImportedFallback: boolean,
  result: Row[],
  lineageById: Record<string, WorktreeLineage>,
  worktreeMap: Map<string, Worktree>,
  nestLineage: boolean,
  cyclicLineageIds: ReadonlySet<string>,
  noticeHostContextLabelByRepoId?: ReadonlyMap<string, NoticeHostContext>,
  duplicatePinnedFolderKeys = false
): void {
  if (pinnedSectionWorktrees.length === 0 && pinnedFolderWorkspaces.length === 0) {
    return
  }
  const pinnedRepoOrder: string[] = []
  const seenPinnedRepoIds = new Set<string>()
  for (const worktree of pinnedSectionWorktrees) {
    if (!seenPinnedRepoIds.has(worktree.repoId)) {
      pinnedRepoOrder.push(worktree.repoId)
      seenPinnedRepoIds.add(worktree.repoId)
    }
  }

  result.push({
    type: 'header',
    key: PINNED_GROUP_KEY,
    label: PINNED_GROUP_META.label,
    count: pinnedSectionWorktrees.length + pinnedFolderWorkspaces.length,
    tone: PINNED_GROUP_META.tone,
    icon: PINNED_GROUP_META.icon,
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      pinnedSectionWorktrees,
      pinnedFolderWorkspaces,
      repoMap,
      defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(
      pinnedSectionWorktrees,
      pinnedFolderWorkspaces,
      repoMap,
      defaultHostId
    ),
    worktreeIds: pinnedSectionWorktrees.map((worktree) => worktree.id)
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
  appendWorktreeRows(result, pinnedSectionWorktrees, repoMap, lineageById, worktreeMap, {
    nestLineage,
    collapsedGroups,
    groupDepth: 0,
    sectionKey: PINNED_GROUP_KEY,
    cyclicLineageIds
  })
  if (allowImportedFallback) {
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
  for (const pair of [...pinnedFolderWorkspaces].sort((left, right) =>
    compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
  )) {
    result.push(
      buildFolderWorkspaceRow(pair, 0, duplicatePinnedFolderKeys ? PINNED_GROUP_KEY : undefined)
    )
  }
}
