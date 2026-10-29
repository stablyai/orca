import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import { getWorktreeExecutionHostId } from '../execution-host'
import type { ExecutionHostId } from '../execution-host'
import { PINNED_GROUP_KEY } from './group-keys'
import { appendWorktreeRows, buildNewExternalWorktreesInboxRow } from './row-builders'
import type { NoticeHostContext } from './host-labels'
import type { NewExternalWorktreesInboxCandidate, RepoOfWorktree, Row } from './row-types'

export function emitPinnedGroup(
  pinnedSectionWorktrees: Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId,
  collapsedGroups: Set<string>,
  renderedNaturalAnchorRepoIds: ReadonlySet<string>,
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>,
  allowNoticeFallback: boolean,
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
    if (!seenPinnedRepoIds.has(worktree.repoId)) {
      pinnedRepoOrder.push(worktree.repoId)
      seenPinnedRepoIds.add(worktree.repoId)
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
  const getFallbackNotice = (repoId: string): Row | null => {
    const candidate = newExternalWorktreesInboxByRepo.get(repoId)
    if (!allowNoticeFallback || !candidate || renderedNaturalAnchorRepoIds.has(repoId)) {
      return null
    }
    return buildNewExternalWorktreesInboxRow(candidate, noticeHostContextLabelByRepoId?.get(repoId))
  }
  if (collapsedGroups.has(PINNED_GROUP_KEY)) {
    for (const repoId of pinnedRepoOrder) {
      const notice = getFallbackNotice(repoId)
      if (notice) {
        result.push(notice)
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
  if (!allowNoticeFallback) {
    return
  }
  // Insert notice fallbacks after the repo’s last row, backwards to avoid shifting later targets.
  const lastResultIndexByRepoId = new Map<string, number>()
  for (let index = firstItemIndex; index < result.length; index++) {
    const row = result[index]
    if (row?.type === 'item') {
      lastResultIndexByRepoId.set(row.worktree.repoId, index)
    }
  }
  const inserts = [...lastResultIndexByRepoId.entries()].sort((left, right) => right[1] - left[1])
  for (const [repoId, index] of inserts) {
    const notice = getFallbackNotice(repoId)
    if (notice) {
      result.splice(index + 1, 0, notice)
    }
  }
}
