import {
  collectCountedCombinedDiffPasses,
  getCombinedDiffCountingPassKey,
  shouldLoadCombinedDiffOnDemand
} from '../../combined-diff-on-demand-load'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { getCombinedDiffFileTreeSectionKey } from '../resolve-changes/combined-diff-section-identity'
import { combinedDiffSectionMatchesEntryMetadata } from '../resolve-changes/combined-diff-section-cache-match'

export function retainCombinedDiffEntryMetadata({
  entrySet,
  previousEntrySet,
  sections
}: {
  entrySet: CombinedDiffEntrySet
  previousEntrySet: CombinedDiffEntrySet
  sections: DiffSection[]
}): { sections: DiffSection[]; changedIndices: number[] } | null {
  if (
    !entrySet.shouldAutoReloadFromGitStatus ||
    !previousEntrySet.shouldAutoReloadFromGitStatus ||
    entrySet.entries.length !== previousEntrySet.entries.length ||
    sections.length !== entrySet.entries.length
  ) {
    return null
  }
  const countedPasses = collectCountedCombinedDiffPasses(entrySet.entries)
  const previousCountedPasses = collectCountedCombinedDiffPasses(previousEntrySet.entries)
  const loadOnDemand = (
    entry: CombinedDiffEntrySet['entries'][number],
    passes: ReadonlySet<string>
  ): boolean =>
    shouldLoadCombinedDiffOnDemand({
      ...entry,
      hasCountedSiblings: passes.has(getCombinedDiffCountingPassKey(entry))
    })
  let retainedSections = sections
  const changedIndices: number[] = []
  for (const [index, entry] of entrySet.entries.entries()) {
    const previousEntry = previousEntrySet.entries[index]
    const section = sections[index]
    if (
      !previousEntry ||
      !section ||
      section.key !== getCombinedDiffFileTreeSectionKey(entrySet.treeMode, entry) ||
      section.key !== getCombinedDiffFileTreeSectionKey(previousEntrySet.treeMode, previousEntry) ||
      loadOnDemand(entry, countedPasses) !== loadOnDemand(previousEntry, previousCountedPasses)
    ) {
      return null
    }
    if (combinedDiffSectionMatchesEntryMetadata(section, entry, entrySet.treeMode)) {
      continue
    }
    if (retainedSections === sections) {
      retainedSections = [...sections]
    }
    retainedSections[index] = {
      ...section,
      status: entry.status,
      oldPath: entry.oldPath,
      added: entry.added,
      removed: entry.removed
    }
    changedIndices.push(index)
  }
  return { sections: retainedSections, changedIndices }
}
