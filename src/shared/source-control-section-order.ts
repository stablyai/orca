import { compareGitStatusEntries } from './git-status-sort'
import { normalizeSourceControlGroupOrder } from './source-control-group-order'
import type { GitStatusEntry } from './git-status-types'
import type { SourceControlGroupOrder } from './ui-chrome-types'

export const SOURCE_CONTROL_AREAS = ['unstaged', 'staged', 'untracked'] as const
export type SourceControlSectionArea = (typeof SOURCE_CONTROL_AREAS)[number]
export type SourceControlDisplaySectionArea = Exclude<SourceControlSectionArea, 'untracked'>
export type SourceControlDisplaySectionId = SourceControlDisplaySectionArea | 'conflicts'

export type SourceControlEntryGroups<T extends GitStatusEntry = GitStatusEntry> = Record<
  SourceControlSectionArea,
  T[]
>

export type SourceControlDisplaySection<T extends GitStatusEntry = GitStatusEntry> = {
  id: SourceControlDisplaySectionId
  area: SourceControlDisplaySectionArea
  items: T[]
}

export type SourceControlConflictReviewEntry = {
  path: string
  conflictKind: NonNullable<GitStatusEntry['conflictKind']>
}

export type SourceControlSectionViewAction =
  | { kind: 'conflict-review'; entries: SourceControlConflictReviewEntry[] }
  | { kind: 'combined-diff'; area?: SourceControlSectionArea; entries: GitStatusEntry[] }

const ORDER_BY_PRESET: Record<
  ReturnType<typeof normalizeSourceControlGroupOrder>,
  readonly SourceControlDisplaySectionArea[]
> = {
  'changes-first': ['unstaged', 'staged'],
  'staged-first': ['staged', 'unstaged']
}

/** Rows by staging area, each sorted conflicts-first then by path, as Source Control lists them. */
export function groupSourceControlEntries<T extends GitStatusEntry>(
  entries: readonly T[]
): SourceControlEntryGroups<T> {
  const groups: SourceControlEntryGroups<T> = { staged: [], unstaged: [], untracked: [] }
  for (const entry of entries) {
    groups[entry.area].push(entry)
  }
  for (const area of SOURCE_CONTROL_AREAS) {
    groups[area].sort(compareGitStatusEntries)
  }
  return groups
}

export function resolveSourceControlGroupOrder(
  value: SourceControlGroupOrder | null | undefined
): readonly SourceControlDisplaySectionArea[] {
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

export type SplitSourceControlGroups<T extends GitStatusEntry = GitStatusEntry> = {
  pinnedConflicts: T[]
  normalGroups: SourceControlEntryGroups<T>
}

export function splitPinnedSourceControlConflicts<T extends GitStatusEntry>(
  groups: SourceControlEntryGroups<T>
): SplitSourceControlGroups<T> {
  const pinnedConflicts = SOURCE_CONTROL_AREAS.flatMap((area) =>
    groups[area].filter(isPinnedConflictEntry)
  )
  // Preserve groups identity without pinned conflicts so status polls do not rebuild downstream trees.
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

export function buildSourceControlDisplaySectionsFromSplit<T extends GitStatusEntry>(
  split: SplitSourceControlGroups<T>,
  order: readonly SourceControlDisplaySectionArea[]
): SourceControlDisplaySection<T>[] {
  const { pinnedConflicts, normalGroups } = split
  const sections: SourceControlDisplaySection<T>[] = []

  if (pinnedConflicts.length > 0) {
    sections.push({ id: 'conflicts', area: 'unstaged', items: pinnedConflicts })
  }

  const changes = [...normalGroups.unstaged, ...normalGroups.untracked].sort(
    compareGitStatusEntries
  )
  for (const area of order) {
    const items = area === 'unstaged' ? changes : normalGroups[area]
    if (items.length > 0) {
      sections.push({ id: area, area, items })
    }
  }

  return sections
}

export function buildSourceControlDisplaySections<T extends GitStatusEntry>(
  groups: SourceControlEntryGroups<T>,
  order: readonly SourceControlDisplaySectionArea[]
): SourceControlDisplaySection<T>[] {
  return buildSourceControlDisplaySectionsFromSplit(
    splitPinnedSourceControlConflicts(groups),
    order
  )
}
