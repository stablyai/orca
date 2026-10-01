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
import { getTagGroupKeys } from './tag-groups'
import { compareRecentRank, recentRankForEntry } from './section-recent-rank'

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
  if (groupBy === 'tag') {
    for (const worktree of worktrees) {
      if (getTagGroupKeys(worktree).some((groupKey) => !collapsedGroups.has(groupKey))) {
        renderedRepoIds.add(worktree.repoId)
      }
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

// Why: disambiguate a section's *own* label, not its anchor checkout's repo
// name. Substituting repo.displayName made a project header read the project
// name while it was the only repo-backed section and the checkout name as soon
// as a second one rendered, so filtering workspaces renamed the project
// (#16127). Path suffixes still resolve genuinely identical labels.
export function withRepoSectionDisplayLabels(
  entries: readonly OrderedGroupEntry[]
): OrderedGroupEntry[] {
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
