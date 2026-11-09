// Labels and order of the desktop sidebar's project sections, shared so the paired phone matches.
import type { ProjectSectionEntry, ProjectSectionRepo } from './project-section-grouping'
import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from './repo-display-labels'
import type { ProjectOrderBy } from './ui-chrome-types'
import { compareCodePoints, compareSidebarText } from './sidebar-list/text-order'

export type ActivityItem = { lastActivityAt?: number }

// Disambiguate each section’s own label, never its anchor checkout’s name: filtering checkout rows previously renamed
// project headers (#16127). Path suffixes still resolve genuinely identical labels.
export function withRepoSectionDisplayLabels<
  E extends ProjectSectionEntry<ActivityItem, ProjectSectionRepo>
>(entries: readonly [string, E][]): [string, E][] {
  const labelItems = entries.flatMap(([, group]) =>
    group.repo ? [{ ...group.repo, displayName: group.label }] : []
  )
  if (labelItems.length === 0) {
    return [...entries]
  }
  const labelsByPath = getRepoDisplayLabelsByPath(labelItems)
  return entries.map(([key, group]) => [
    key,
    group.repo
      ? { ...group, label: labelsByPath.get(getRepoDisplayLabelKey(group.repo)) ?? group.label }
      : group
  ])
}

/** Visible activity always beats placeholder addedAt; within each tier, newest timestamps rank first. */
type RecentRank = { hasActivity: boolean; ts: number }

export function recentRankForEntry(
  entry: readonly [string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>]
): RecentRank {
  let max = Number.NEGATIVE_INFINITY
  for (const worktree of entry[1].activityItems ?? entry[1].items) {
    // Why: phone rows from older hosts may omit the timestamp; the desktop's always carry one.
    if ((worktree.lastActivityAt ?? Number.NEGATIVE_INFINITY) > max) {
      max = worktree.lastActivityAt ?? max
    }
  }
  if (max !== Number.NEGATIVE_INFINITY) {
    // Use timestamps because incoming rows are no longer presorted once project order is independent of workspace sort.
    return { hasActivity: true, ts: max }
  }
  const addedAt = entry[1].repo?.addedAt
  return {
    hasActivity: false,
    ts: typeof addedAt === 'number' ? addedAt : Number.NEGATIVE_INFINITY
  }
}

export function createRecentRankLookup<
  T extends readonly [string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>]
>(): (entry: T) => RecentRank {
  const ranks = new Map<T, RecentRank>()
  return (entry) => {
    const existing = ranks.get(entry)
    if (existing) {
      return existing
    }
    const rank = recentRankForEntry(entry)
    ranks.set(entry, rank)
    return rank
  }
}

export function compareRecentRank(a: RecentRank, b: RecentRank): number {
  if (a.hasActivity !== b.hasActivity) {
    return a.hasActivity ? -1 : 1
  }
  return b.ts - a.ts
}

function manualRankForEntry(
  entry: readonly [string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>],
  repoOrder: ReadonlyMap<string, number> | undefined
): number {
  const key = entry[0]
  const repoIds =
    entry[1].repoIds.size > 0
      ? [...entry[1].repoIds]
      : [key.startsWith('repo:') ? key.slice('repo:'.length) : key]
  let rank = Number.POSITIVE_INFINITY
  for (const repoId of repoIds) {
    const repoRank = repoOrder?.get(repoId)
    if (repoRank !== undefined && repoRank < rank) {
      rank = repoRank
    }
  }
  return rank
}

export function isProjectSectionEntryPinned<R extends ProjectSectionRepo>(
  entry: readonly [string, ProjectSectionEntry<unknown, R>],
  repoMap?: ReadonlyMap<string, R>,
  pinnedRepoIds?: ReadonlySet<string>
): boolean {
  if (entry[1].repo?.isPinned === true) {
    return true
  }
  if (pinnedRepoIds) {
    if (entry[1].repo && pinnedRepoIds.has(entry[1].repo.id)) {
      return true
    }
    for (const repoId of entry[1].repoIds) {
      if (pinnedRepoIds.has(repoId)) {
        return true
      }
    }
  }
  if (repoMap) {
    for (const repoId of entry[1].repoIds) {
      if (repoMap.get(repoId)?.isPinned === true) {
        return true
      }
    }
  }
  return false
}

export function getManualOrderAnchorRepo<R extends ProjectSectionRepo>(
  group: ProjectSectionEntry<unknown, R>,
  repoMap: ReadonlyMap<string, R>,
  repoOrder: ReadonlyMap<string, number> | undefined,
  pinnedRepoIds?: ReadonlySet<string>
): R | undefined {
  const isPinned = (candidate: R | undefined): boolean =>
    Boolean(candidate && (candidate.isPinned === true || pinnedRepoIds?.has(candidate.id)))
  let anchor = group.repo
  let anchorPinned = isPinned(anchor)
  let anchorRank = anchor ? (repoOrder?.get(anchor.id) ?? Number.POSITIVE_INFINITY) : undefined
  for (const repoId of group.repoIds) {
    const repo = repoMap.get(repoId)
    if (!repo) {
      continue
    }
    const pinned = isPinned(repo)
    const rank = repoOrder?.get(repoId) ?? Number.POSITIVE_INFINITY
    const beatsAnchor =
      !anchor ||
      (pinned !== anchorPinned ? pinned : rank < (anchorRank ?? Number.POSITIVE_INFINITY))
    if (beatsAnchor) {
      anchor = repo
      anchorPinned = pinned
      anchorRank = rank
    }
  }
  return anchor
}

/** Order headers by canonical repo order or newest visible workspace activity; inactive projects trail, then manual rank and label break ties. */
export function sortProjectEntries<
  T extends readonly [string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>]
>(
  entries: T[],
  projectOrderBy: ProjectOrderBy,
  repoOrder: ReadonlyMap<string, number> | undefined,
  repoMap?: ReadonlyMap<string, ProjectSectionRepo>,
  pinnedRepoIds?: ReadonlySet<string>
): T[] {
  if (projectOrderBy === 'recent') {
    if (entries.length < 2) {
      return [...entries]
    }
    const getRecentRank = createRecentRankLookup<T>()
    return [...entries].sort((a, b) => {
      const byPin =
        (isProjectSectionEntryPinned(b, repoMap, pinnedRepoIds) ? 1 : 0) -
        (isProjectSectionEntryPinned(a, repoMap, pinnedRepoIds) ? 1 : 0)
      if (byPin !== 0) {
        return byPin
      }
      const byRecent = compareRecentRank(getRecentRank(a), getRecentRank(b))
      if (byRecent !== 0) {
        return byRecent
      }
      const ma = manualRankForEntry(a, repoOrder)
      const mb = manualRankForEntry(b, repoOrder)
      if (ma !== mb) {
        return ma - mb
      }
      return compareSidebarText(a[1].label, b[1].label) || compareCodePoints(a[0], b[0])
    })
  }
  if (!repoOrder) {
    if (!entries.some((entry) => isProjectSectionEntryPinned(entry, repoMap, pinnedRepoIds))) {
      return entries
    }
    return [...entries].sort(
      (a, b) =>
        (isProjectSectionEntryPinned(b, repoMap, pinnedRepoIds) ? 1 : 0) -
        (isProjectSectionEntryPinned(a, repoMap, pinnedRepoIds) ? 1 : 0)
    )
  }
  return [...entries].sort((a, b) => {
    const byPin =
      (isProjectSectionEntryPinned(b, repoMap, pinnedRepoIds) ? 1 : 0) -
      (isProjectSectionEntryPinned(a, repoMap, pinnedRepoIds) ? 1 : 0)
    if (byPin !== 0) {
      return byPin
    }
    const ra = manualRankForEntry(a, repoOrder)
    const rb = manualRankForEntry(b, repoOrder)
    if (ra !== rb) {
      return ra - rb
    }
    return compareSidebarText(a[1].label, b[1].label) || compareCodePoints(a[0], b[0])
  })
}

/** Anchor headers on the leading manual repo so dragging/actions and row sorting share the persisted ordering source. */
export function orderProjectSections<
  R extends ProjectSectionRepo,
  E extends ProjectSectionEntry<ActivityItem, R>
>(
  sections: ReadonlyMap<string, E>,
  repoMap: ReadonlyMap<string, R>,
  repoOrder: ReadonlyMap<string, number> | undefined,
  projectOrderBy: ProjectOrderBy,
  pinnedRepoIds?: ReadonlySet<string>
): [string, E][] {
  for (const section of sections.values()) {
    section.repo = getManualOrderAnchorRepo(section, repoMap, repoOrder, pinnedRepoIds)
  }
  // Project header order is independent of workspace sortBy.
  return sortProjectEntries(
    Array.from(sections.entries()),
    projectOrderBy,
    repoOrder,
    repoMap,
    pinnedRepoIds
  )
}

/** Each repo id's rank in catalog order; the first occurrence wins across hosts. */
export function getLogicalRepoOrderRankById(
  orderedRepoIds: readonly string[]
): Map<string, number> {
  const rankById = new Map<string, number>()
  orderedRepoIds.forEach((repoId, index) => {
    // Shared logical project IDs anchor to first occurrence, independent of host load order.
    if (!rankById.has(repoId)) {
      rankById.set(repoId, index)
    }
  })
  return rankById
}
