import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { CombinedDiffFileTreeMode } from './combined-diff-file-tree-model'
import type { DiffSection } from './diff-section-types'

export type RemappedCombinedDiffSections = {
  sections: DiffSection[]
  /** Previous section index for each remapped row; used to keep measured heights. */
  sourceIndexes: number[]
}

/**
 * Remap loaded sections onto the current entry list (area moves + removals).
 *
 * Matches by path (preferring same area, then any area) so Monaco bodies and
 * section keys stay stable across stage/unstage. Builds `sourceIndexes` in the
 * new `entries` order so measured heights can follow permutations.
 *
 * @returns Remapped sections + prior indexes, or `null` when a new path appears
 *   (caller should rebuild from scratch).
 */
export function remapCombinedDiffSectionsForAreaMove({
  sections,
  entries
}: {
  sections: readonly DiffSection[]
  entries: readonly (GitStatusEntry | GitBranchChangeEntry)[]
  treeMode: CombinedDiffFileTreeMode
}): RemappedCombinedDiffSections | null {
  if (sections.length === 0) {
    return entries.length === 0 ? { sections: sections as DiffSection[], sourceIndexes: [] } : null
  }

  const usedSectionIndexes = new Set<number>()
  const remapped: DiffSection[] = []
  const sourceIndexes: number[] = []
  let changed = sections.length !== entries.length

  for (const entry of entries) {
    const entryArea = 'area' in entry ? entry.area : undefined
    const entryAdded = 'added' in entry ? entry.added : undefined
    const entryRemoved = 'removed' in entry ? entry.removed : undefined

    let matchIndex = -1
    for (let index = 0; index < sections.length; index += 1) {
      if (usedSectionIndexes.has(index)) {
        continue
      }
      const section = sections[index]
      if (section && section.path === entry.path && section.area === entryArea) {
        matchIndex = index
        break
      }
    }
    if (matchIndex < 0) {
      for (let index = 0; index < sections.length; index += 1) {
        if (usedSectionIndexes.has(index)) {
          continue
        }
        const section = sections[index]
        if (section && section.path === entry.path) {
          matchIndex = index
          break
        }
      }
    }
    if (matchIndex < 0) {
      return null
    }

    usedSectionIndexes.add(matchIndex)
    const section = sections[matchIndex]
    if (!section) {
      return null
    }
    sourceIndexes.push(matchIndex)

    if (
      section.status !== entry.status ||
      section.area !== entryArea ||
      section.oldPath !== entry.oldPath ||
      section.added !== entryAdded ||
      section.removed !== entryRemoved
    ) {
      changed = true
      remapped.push({
        ...section,
        status: entry.status,
        area: entryArea,
        oldPath: entry.oldPath,
        added: entryAdded,
        removed: entryRemoved
      })
      continue
    }
    remapped.push(section)
  }

  if (!changed) {
    return { sections: sections as DiffSection[], sourceIndexes }
  }
  return { sections: remapped, sourceIndexes }
}

/**
 * Reindex measured section heights to match a remapped row order.
 *
 * `sourceIndexes[i]` is the previous section index that now sits at `i`, so
 * height at the old index moves with the row even when length is unchanged
 * (same-length area-group permutations from stage/unstage).
 */
export function remapCombinedDiffSectionHeights(
  previousHeights: Record<number, number>,
  sourceIndexes: readonly number[]
): Record<number, number> {
  const next: Record<number, number> = {}
  for (let index = 0; index < sourceIndexes.length; index += 1) {
    const sourceIndex = sourceIndexes[index]
    if (sourceIndex === undefined) {
      continue
    }
    const height = previousHeights[sourceIndex]
    if (height !== undefined) {
      next[index] = height
    }
  }
  return next
}
