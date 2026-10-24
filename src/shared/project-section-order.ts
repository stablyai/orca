// Labels and order of the desktop sidebar's project sections, shared so the paired phone matches.
import type { ProjectSectionEntry, ProjectSectionRepo } from './project-section-grouping'
import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from './repo-display-labels'
import type { ProjectOrderBy } from './ui-chrome-types'
import { compareCodePoints, compareSidebarText } from './sidebar-list/text-order'

export type ActivityItem = { lastActivityAt?: number }

// Why: disambiguate a section's *own* label, not its anchor checkout's repo
// name. Substituting repo.displayName made a project header read the project
// name while it was the only repo-backed section and the checkout name as soon
// as a second one rendered, so filtering workspaces renamed the project
// (#16127). Path suffixes still resolve genuinely identical labels.
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

/**
 * Recent rank for a project header. `hasActivity` projects (at least one
 * visible worktree) always sort before fallback projects, regardless of the
 * numeric values — a placeholder's `addedAt` must never outrank real activity.
 * Within each tier, higher timestamps come first.
 */
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
    // Why: Recent must be timestamp-based, not encounter order — the incoming
    // array is no longer pre-sorted by recency once decoupled from sortBy.
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

export function getManualOrderAnchorRepo<R extends ProjectSectionRepo>(
  group: ProjectSectionEntry<unknown, R>,
  repoMap: ReadonlyMap<string, R>,
  repoOrder: ReadonlyMap<string, number> | undefined
): R | undefined {
  let anchor = group.repo
  let anchorRank = anchor ? (repoOrder?.get(anchor.id) ?? Number.POSITIVE_INFINITY) : undefined
  for (const repoId of group.repoIds) {
    const repo = repoMap.get(repoId)
    if (!repo) {
      continue
    }
    const rank = repoOrder?.get(repoId) ?? Number.POSITIVE_INFINITY
    if (!anchor || rank < (anchorRank ?? Number.POSITIVE_INFINITY)) {
      anchor = repo
      anchorRank = rank
    }
  }
  return anchor
}

/**
 * Order project header entries by the user's project-order preference. Manual
 * follows the canonical repoOrder; Recent follows each project's most recent
 * visible workspace activity (descending), with empty/imported-only projects
 * sorting after active ones, then by manual rank, then label. Name sorts by label.
 */
export function sortProjectEntries<
  T extends readonly [string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>]
>(
  entries: T[],
  projectOrderBy: ProjectOrderBy,
  repoOrder: ReadonlyMap<string, number> | undefined
): T[] {
  if (projectOrderBy === 'recent') {
    if (entries.length < 2) {
      return [...entries]
    }
    const getRecentRank = createRecentRankLookup<T>()
    return [...entries].sort((a, b) => {
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
  if (projectOrderBy === 'name') {
    return [...entries].sort(
      (a, b) => compareSidebarText(a[1].label, b[1].label) || compareCodePoints(a[0], b[0])
    )
  }
  if (!repoOrder) {
    return entries
  }
  return [...entries].sort((a, b) => {
    const ra = manualRankForEntry(a, repoOrder)
    const rb = manualRankForEntry(b, repoOrder)
    if (ra !== rb) {
      return ra - rb
    }
    return compareSidebarText(a[1].label, b[1].label) || compareCodePoints(a[0], b[0])
  })
}

export function partitionRunningFirst<T>(
  entries: readonly T[],
  isRunning: (entry: T) => boolean
): T[] {
  const running: T[] = []
  const rest: T[] = []
  for (const entry of entries) {
    ;(isRunning(entry) ? running : rest).push(entry)
  }
  return [...running, ...rest]
}

/**
 * Project sections in header order. Each header anchors on the repo that leads manual order, so
 * drag and actions target the same persisted order source the row sorter reads.
 */
export function orderProjectSections<
  R extends ProjectSectionRepo,
  E extends ProjectSectionEntry<ActivityItem, R>
>(
  sections: ReadonlyMap<string, E>,
  repoMap: ReadonlyMap<string, R>,
  repoOrder: ReadonlyMap<string, number> | undefined,
  projectOrderBy: ProjectOrderBy,
  /** Set to lift running projects above idle ones, each keeping the chosen order. */
  isRunningSection?: (section: E) => boolean
): [string, E][] {
  for (const section of sections.values()) {
    section.repo = getManualOrderAnchorRepo(section, repoMap, repoOrder)
  }
  // Why: project header order is its own user choice (projectOrderBy), decoupled from workspace
  // sortBy. Manual uses the canonical repoOrder; Recent follows activity.
  const sorted = sortProjectEntries(Array.from(sections.entries()), projectOrderBy, repoOrder)
  return isRunningSection
    ? partitionRunningFirst(sorted, ([, section]) => isRunningSection(section))
    : sorted
}

/** Each repo id's rank in catalog order; the first occurrence wins across hosts. */
export function getLogicalRepoOrderRankById(
  orderedRepoIds: readonly string[]
): Map<string, number> {
  const rankById = new Map<string, number>()
  orderedRepoIds.forEach((repoId, index) => {
    // Why: paired hosts can contribute the same logical project ID; its merged
    // header must anchor to the first occurrence instead of whichever host loaded last.
    if (!rankById.has(repoId)) {
      rankById.set(repoId, index)
    }
  })
  return rankById
}
