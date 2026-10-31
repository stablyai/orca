import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import { PINNED_GROUP_KEY } from './group-keys'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildImportedWorktreesCardRow
} from './row-builders'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './host-labels'
import type { NoticeHostContext } from './host-labels'
import type { ImportedWorktreesCardCandidate, RepoOfWorktree, Row } from './row-types'

export function emitPinnedGroup(
  pinnedSectionWorktrees: Worktree[],
  pinnedFolderWorkspaces: readonly RenderableFolderWorkspace[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId,
  collapsedGroups: Set<string>,
  renderedNaturalAnchorRepoIds: ReadonlySet<string>,
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>,
  allowImportedFallback: boolean,
  result: Row[],
  occurrencePlan: WorktreeOccurrencePlan<Worktree>,
  noticeHostContextLabelByRepoId?: ReadonlyMap<string, NoticeHostContext>,
  hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
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
    count: pinnedSectionWorktrees.length + pinnedFolderWorkspaces.length,
    icon: { kind: 'pinned' },
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      pinnedSectionWorktrees,
      pinnedFolderWorkspaces,
      repoOf,
      defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(
      pinnedSectionWorktrees,
      pinnedFolderWorkspaces,
      repoOf,
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
  appendWorktreeRows(result, repoOf, occurrencePlan, {
    collapsedGroups,
    groupDepth: 0,
    sectionKey: PINNED_GROUP_KEY,
    hostContextLabelByWorktreeIdentity
  })
  for (const pair of pinnedFolderWorkspaces) {
    result.push(buildFolderWorkspaceRow(pair, 0))
  }
  if (!allowImportedFallback) {
    return
  }
  // Insert imported fallbacks after the repo’s last row, backwards to avoid shifting later targets.
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
