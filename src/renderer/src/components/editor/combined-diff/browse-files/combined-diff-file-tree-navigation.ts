import {
  getCombinedDiffFileTreeSectionKey,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'

export function getCombinedDiffFileTreeNavigationIndex({
  mode,
  entry,
  sectionIndexByKey
}: {
  mode: CombinedDiffFileTreeMode
  entry: CombinedDiffFileTreeEntry
  sectionIndexByKey: ReadonlyMap<string, number>
}): number | null {
  return sectionIndexByKey.get(getCombinedDiffFileTreeSectionKey(mode, entry)) ?? null
}

export function handleCombinedDiffFileTreeNavigation({
  mode,
  entry,
  sections,
  sectionIndexByKey,
  toggleSection,
  loadSection,
  scrollToIndex
}: {
  mode: CombinedDiffFileTreeMode
  entry: CombinedDiffFileTreeEntry
  sections: readonly { collapsed: boolean }[]
  sectionIndexByKey: ReadonlyMap<string, number>
  toggleSection: (index: number) => void
  loadSection?: (index: number) => void
  scrollToIndex: (index: number) => void
}): number | null {
  const index = getCombinedDiffFileTreeNavigationIndex({ mode, entry, sectionIndexByKey })
  if (index === null || !sections[index]) {
    return null
  }

  if (sections[index].collapsed) {
    toggleSection(index)
  }
  loadSection?.(index)
  scrollToIndex(index)
  return index
}
