import type { Worktree } from '../worktree/types'
import type { WorktreeOccurrenceSection } from '../worktree-occurrence-plan'
import type { WorktreeGroupEntry, OrderedGroupEntry } from './worktree-group-entry'
import { isFolderLaneSectionKey } from './folder-workspace-occurrences'
import { PINNED_GROUP_KEY } from './group-keys'
import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

export function orderMainWorktreeFirst<T extends { isMainWorktree?: boolean }>(
  worktrees: T[],
  sortBy: WorkspaceSortBy
): T[] {
  if (sortBy === 'manual') {
    return worktrees
  }
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Keep canonical workspaces first for repo-scanned project groups despite dynamic child ranking.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

export function getOrderedOccurrenceGroups(
  sections: readonly (WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry })[]
) {
  const pinnedSectionWorktrees =
    sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = sections
    .filter((section) => section.key !== PINNED_GROUP_KEY && !isFolderLaneSectionKey(section.key))
    .map((section) => [section.key, section.group])
  const naturalWorktrees = orderedGroups.flatMap(([, group]) => group.items)
  return { pinnedSectionWorktrees, orderedGroups, naturalWorktrees }
}
