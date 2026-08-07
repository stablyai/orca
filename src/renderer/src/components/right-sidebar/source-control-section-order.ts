import { normalizeSourceControlGroupOrder } from '../../../../shared/source-control-group-order'
import type { GitStatusEntry, SourceControlGroupOrder } from '../../../../shared/types'

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

export type SourceControlSectionViewAction =
  | { kind: 'conflict-review'; entries: SourceControlConflictReviewEntry[] }
  | { kind: 'combined-diff'; area?: SourceControlSectionArea; entries: GitStatusEntry[] }

const ORDER_BY_PRESET: Record<SourceControlGroupOrder, readonly SourceControlSectionArea[]> = {
  'changes-first': ['unstaged', 'staged', 'untracked'],
  'staged-first': ['staged', 'unstaged', 'untracked'],
  'untracked-first': ['untracked', 'unstaged', 'staged']
}

export function resolveSourceControlGroupOrder(
  value: SourceControlGroupOrder | null | undefined
): readonly SourceControlSectionArea[] {
  return ORDER_BY_PRESET[normalizeSourceControlGroupOrder(value)]
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

export function getSourceControlSectionViewAction(
  section: SourceControlDisplaySection
): SourceControlSectionViewAction | null {
  if (section.id === 'conflicts') {
    const entries = getConflictReviewEntries(section.items)
    if (entries.length > 0) {
      return { kind: 'conflict-review', entries }
    }
    if (section.items.length === 0) {
      return null
    }
    const [firstItem] = section.items
    const area = section.items.every((item) => item.area === firstItem?.area)
      ? firstItem?.area
      : undefined
    return area
      ? { kind: 'combined-diff', area, entries: section.items }
      : { kind: 'combined-diff', entries: section.items }
  }
  return { kind: 'combined-diff', area: section.area, entries: section.items }
}

export type SplitSourceControlGroups = {
  pinnedConflicts: GitStatusEntry[]
  normalGroups: SourceControlEntryGroups
}

export function splitPinnedSourceControlConflicts(
  groups: SourceControlEntryGroups
): SplitSourceControlGroups {
  const pinnedConflicts = SOURCE_CONTROL_AREAS.flatMap((area) =>
    groups[area].filter(isPinnedConflictEntry)
  )
  // Why: preserve referential identity of `groups` when nothing is pinned so
  // downstream memos (tree rebuilds, etc.) don't fire on every status refresh.
  if (pinnedConflicts.length === 0) {
    return { pinnedConflicts, normalGroups: groups }
  }
  return {
    pinnedConflicts,
    normalGroups: {
      staged: groups.staged.filter((entry) => !isPinnedConflictEntry(entry)),
      unstaged: groups.unstaged.filter((entry) => !isPinnedConflictEntry(entry)),
      untracked: groups.untracked.filter((entry) => !isPinnedConflictEntry(entry))
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
