import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../../store/types'
import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from '@/lib/repo-display-labels'
import { ALL_GROUP_KEY } from './group-keys'
import type {
  OrderedGroupEntry,
  ProjectGroupingModel,
  WorktreeGroupEntry
} from './project-grouping'
import type { WorktreeGroupBy } from './row-types'
import { getGroupKeyForWorktree } from './worktree-group-keys'

export function getRenderedNaturalAnchorRepoIds({
  groupBy,
  worktrees,
  repoMap,
  prCache,
  collapsedGroups,
  workspaceStatuses,
  settings,
  projectGrouping
}: {
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  collapsedGroups: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings?: AppState['settings']
  projectGrouping?: ProjectGroupingModel
}): Set<string> {
  const renderedRepoIds = new Set<string>()
  if (groupBy === 'none') {
    if (!collapsedGroups.has(ALL_GROUP_KEY)) {
      for (const worktree of worktrees) {
        renderedRepoIds.add(worktree.repoId)
      }
    }
    return renderedRepoIds
  }
  if (groupBy === 'repo') {
    for (const worktree of worktrees) {
      renderedRepoIds.add(worktree.repoId)
    }
    return renderedRepoIds
  }
  for (const worktree of worktrees) {
    const groupKey = getGroupKeyForWorktree(
      groupBy,
      worktree,
      repoMap,
      prCache,
      workspaceStatuses,
      settings,
      projectGrouping
    )
    if (groupKey && !collapsedGroups.has(groupKey)) {
      renderedRepoIds.add(worktree.repoId)
    }
  }
  return renderedRepoIds
}

export function orderMainWorktreeFirst(worktrees: Worktree[]): Worktree[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Why: project groups are scanned by repo; keep the repo's canonical
  // workspace anchored even when dynamic sorts rank a child workspace first.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

export function withRepoSectionDisplayLabels(
  entries: readonly OrderedGroupEntry[]
): OrderedGroupEntry[] {
  const repos = entries
    .map((entry) => entry[1].repo)
    .filter((repo): repo is Repo => repo !== undefined)
  if (repos.length < 2) {
    return [...entries]
  }
  const labelsByPath = getRepoDisplayLabelsByPath(repos)
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

export function recentRankForEntry(entry: OrderedGroupEntry): RecentRank {
  let max = Number.NEGATIVE_INFINITY
  for (const worktree of entry[1].items) {
    if (worktree.lastActivityAt > max) {
      max = worktree.lastActivityAt
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

export function compareRecentRank(a: RecentRank, b: RecentRank): number {
  if (a.hasActivity !== b.hasActivity) {
    return a.hasActivity ? -1 : 1
  }
  return b.ts - a.ts
}

function manualRankForEntry(
  entry: OrderedGroupEntry,
  repoOrder: Map<string, number> | undefined
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

export function getManualOrderAnchorRepo(
  group: WorktreeGroupEntry,
  repoMap: Map<string, Repo>,
  repoOrder: Map<string, number> | undefined
): Repo | undefined {
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
 * sorting after active ones, then by manual rank, then label.
 */
export function sortProjectEntries(
  entries: OrderedGroupEntry[],
  projectOrderBy: ProjectOrderBy,
  repoOrder: Map<string, number> | undefined
): OrderedGroupEntry[] {
  if (projectOrderBy === 'recent') {
    return [...entries].sort((a, b) => {
      const byRecent = compareRecentRank(recentRankForEntry(a), recentRankForEntry(b))
      if (byRecent !== 0) {
        return byRecent
      }
      const ma = manualRankForEntry(a, repoOrder)
      const mb = manualRankForEntry(b, repoOrder)
      if (ma !== mb) {
        return ma - mb
      }
      return a[1].label.localeCompare(b[1].label)
    })
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
    return a[1].label.localeCompare(b[1].label)
  })
}

/**
 * Build the flat row list consumed by the virtualizer.
 * Extracted here to keep WorktreeList.tsx under the line-count lint limit.
 */
