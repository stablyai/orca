import { getRepoHostIdentity, getRepoHostIdentityForParts } from '../repo-host-identity'
import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import { getWorktreeExecutionHostId } from '../execution-host'
import type { ExecutionHostId } from '../execution-host'
import { PINNED_GROUP_KEY } from './group-keys'
import { appendWorktreeRows, buildImportedWorktreesCardRow } from './row-builders'
import type { NoticeHostContext } from './host-labels'
import type { ImportedWorktreesCardCandidate, RepoOfWorktree, Row } from './row-types'

export function emitPinnedGroup(
  pinnedSectionWorktrees: Worktree[],
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
  if (pinnedSectionWorktrees.length === 0) {
    return
  }
  const hostWorktreeCounts = new Map<ExecutionHostId, number>()
  const hostWorktreeIds = new Map<ExecutionHostId, string[]>()
  const pinnedRepoOrder: string[] = []
  const seenPinnedRepoIds = new Set<string>()
  for (const worktree of pinnedSectionWorktrees) {
    const hostId = getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId)
    hostWorktreeCounts.set(hostId, (hostWorktreeCounts.get(hostId) ?? 0) + 1)
    const hostIds = hostWorktreeIds.get(hostId) ?? []
    hostIds.push(worktree.id)
    hostWorktreeIds.set(hostId, hostIds)
    if (!seenPinnedRepoIds.has(getRepoHostIdentityForParts(worktree.repoId, hostId))) {
      pinnedRepoOrder.push(getRepoHostIdentityForParts(worktree.repoId, hostId))
      seenPinnedRepoIds.add(getRepoHostIdentityForParts(worktree.repoId, hostId))
    }
  }

  result.push({
    type: 'header',
    key: PINNED_GROUP_KEY,
    count: pinnedSectionWorktrees.length,
    icon: { kind: 'pinned' },
    hostWorktreeCounts,
    hostWorktreeIds,
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

  const pinnedRows: Row[] = []
  appendWorktreeRows(pinnedRows, repoOf, occurrencePlan, {
    collapsedGroups,
    groupDepth: 0,
    sectionKey: PINNED_GROUP_KEY,
    hostContextLabelByWorktreeIdentity
  })
  const lastIndexByOwner = new Map<string, number>()
  for (let index = 0; index < pinnedRows.length; index++) {
    const row = pinnedRows[index]
    if (row.type === 'item') {
      lastIndexByOwner.set(
        getRepoHostIdentityForParts(
          row.worktree.repoId,
          getWorktreeExecutionHostId(row.worktree, repoOf(row.worktree), defaultHostId)
        ),
        index
      )
    }
  }
  const fallbackByIndex = new Map<number, ImportedWorktreesCardCandidate>()
  if (allowImportedFallback) {
    for (const [owner, index] of lastIndexByOwner) {
      const candidate = importedWorktreesByRepo.get(owner)
      if (candidate && !renderedNaturalAnchorRepoIds.has(owner)) {
        fallbackByIndex.set(index, candidate)
      }
    }
  }
  for (let index = 0; index < pinnedRows.length; index++) {
    result.push(pinnedRows[index])
    const candidate = fallbackByIndex.get(index)
    if (candidate) {
      result.push(
        buildImportedWorktreesCardRow(
          candidate,
          'pinned-fallback',
          noticeHostContextLabelByRepoId?.get(getRepoHostIdentity(candidate.repo))
        )
      )
    }
  }
}
