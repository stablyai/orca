import { useCallback } from 'react'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import type { CombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import { fetchCombinedDiffSection } from '../load-sections/fetch-combined-diff-section'

export function useCombinedDiffReviewLoader({
  entrySet,
  file,
  registry
}: {
  entrySet: CombinedDiffEntrySet
  file: OpenFile
  registry: CombinedDiffSectionLoadRegistry
}): (index: number) => ReturnType<typeof fetchCombinedDiffSection> {
  const { branchCompare, commitCompare, isAllMode, isBranchMode, isCommitMode } = entrySet
  const { generationRef, sectionLoadTokensRef } = registry
  const loadSectionForReview = useCallback(
    async (index: number) => {
      const entry = entrySet.entries[index]
      if (!entry) {
        throw new Error('Diff entry is no longer available')
      }
      const gen = generationRef.current
      const token = sectionLoadTokensRef.current.get(index) ?? 0
      const loaded = await fetchCombinedDiffSection({
        branchCompare,
        commitCompare,
        entry,
        file,
        isAllMode,
        isBranchMode,
        isCommitMode
      })
      await loaded.reviewModifiedTime
      const assertCurrent = () => {
        loaded.operation.assertCurrent()
        if (
          generationRef.current !== gen ||
          (sectionLoadTokensRef.current.get(index) ?? 0) !== token
        ) {
          throw new Error('Diff entry changed while loading')
        }
      }
      assertCurrent()
      return { ...loaded, operation: { ...loaded.operation, assertCurrent } }
    },
    [
      entrySet.entries,
      file,
      branchCompare,
      commitCompare,
      isAllMode,
      isBranchMode,
      isCommitMode,
      generationRef,
      sectionLoadTokensRef
    ]
  )

  return loadSectionForReview
}
