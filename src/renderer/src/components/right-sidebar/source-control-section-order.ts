import type { GitStatusEntry, SourceControlGroupOrder } from '../../../../shared/types'

export const DEFAULT_SOURCE_CONTROL_GROUP_ORDER: SourceControlGroupOrder = 'changes-first'

export const SOURCE_CONTROL_AREAS = ['unstaged', 'staged', 'untracked'] as const
export type SourceControlSectionArea = (typeof SOURCE_CONTROL_AREAS)[number]
export type SourceControlDisplaySectionId = SourceControlSectionArea | 'conflicts'

export type SourceControlEntryGroups = Record<SourceControlSectionArea, GitStatusEntry[]>

export type SourceControlDisplaySection = {
  id: SourceControlDisplaySectionId
  area: SourceControlSectionArea
  items: GitStatusEntry[]
}

export type SourceControlConflictReviewEntry = {
  path: string
  conflictKind: NonNullable<GitStatusEntry['conflictKind']>
}

const ORDER_BY_PRESET: Record<SourceControlGroupOrder, readonly SourceControlSectionArea[]> = {
  'changes-first': ['unstaged', 'staged', 'untracked'],
  'staged-first': ['staged', 'unstaged', 'untracked'],
  'untracked-first': ['untracked', 'unstaged', 'staged']
}

export function resolveSourceControlGroupOrder(
  value: SourceControlGroupOrder | null | undefined
): readonly SourceControlSectionArea[] {
  return (
    ORDER_BY_PRESET[value ?? DEFAULT_SOURCE_CONTROL_GROUP_ORDER] ?? ORDER_BY_PRESET['changes-first']
  )
}

export function isPinnedConflictEntry(entry: GitStatusEntry): boolean {
  return entry.conflictStatus === 'unresolved' || entry.conflictStatus === 'resolved_locally'
}

export function getConflictReviewEntries(
  entries: readonly GitStatusEntry[]
): SourceControlConflictReviewEntry[] {
  return entries
    .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
    .map((entry) => ({
      path: entry.path,
      conflictKind: entry.conflictKind!
    }))
}

export type SplitSourceControlGroups = {
  pinnedConflicts: GitStatusEntry[]
  normalGroups: SourceControlEntryGroups
}

export function splitPinnedSourceControlConflicts(
  groups: SourceControlEntryGroups
): SplitSourceControlGroups {
  const pinnedConflicts = groups.unstaged.filter(isPinnedConflictEntry)
  // Why: preserve referential identity of `groups` when nothing is pinned so
  // downstream memos (tree rebuilds, etc.) don't fire on every status refresh.
  if (pinnedConflicts.length === 0) {
    return { pinnedConflicts, normalGroups: groups }
  }
  return {
    pinnedConflicts,
    normalGroups: {
      staged: groups.staged,
      unstaged: groups.unstaged.filter((entry) => !isPinnedConflictEntry(entry)),
      untracked: groups.untracked
    }
  }
}

export function buildSourceControlDisplaySectionsFromSplit(
  split: SplitSourceControlGroups,
  order: readonly SourceControlSectionArea[]
): SourceControlDisplaySection[] {
  const { pinnedConflicts, normalGroups } = split
  const sections: SourceControlDisplaySection[] = []

  if (pinnedConflicts.length > 0) {
    sections.push({ id: 'conflicts', area: 'unstaged', items: pinnedConflicts })
  }

  for (const area of order) {
    const items = normalGroups[area]
    if (items.length > 0) {
      sections.push({ id: area, area, items })
    }
  }

  return sections
}

export function buildSourceControlDisplaySections(
  groups: SourceControlEntryGroups,
  order: readonly SourceControlSectionArea[]
): SourceControlDisplaySection[] {
  return buildSourceControlDisplaySectionsFromSplit(
    splitPinnedSourceControlConflicts(groups),
    order
  )
}
