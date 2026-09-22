import { useEffect } from 'react'
import type React from 'react'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'
import { combinedDiffScrollTopCache, combinedDiffViewStateCache } from './combined-diff-view-memory'

export function useCombinedDiffViewPersist({
  combinedGitStatusSignature,
  entryCount,
  entrySignature,
  scrollContainerRef,
  sectionHeights,
  sections,
  loadedIndicesRef,
  sideBySide,
  viewStateKey
}: {
  combinedGitStatusSignature: string
  entryCount: number
  entrySignature: string
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  loadedIndicesRef: React.RefObject<Set<number>>
  sideBySide: boolean
  viewStateKey: string
}): void {
  useEffect(() => {
    if (sections.length === 0 && entryCount > 0) {
      return
    }
    const preservedScrollTop =
      combinedDiffScrollTopCache.get(viewStateKey) ?? scrollContainerRef.current?.scrollTop ?? 0
    setWithLRU(combinedDiffViewStateCache, viewStateKey, {
      entrySignature,
      gitStatusSignature: combinedGitStatusSignature,
      sections,
      sectionHeights,
      loadedIndices: Array.from(loadedIndicesRef.current).filter(
        (index) => !sections[index]?.loading
      ),
      scrollTop: preservedScrollTop,
      sideBySide
    })
  }, [
    combinedGitStatusSignature,
    entryCount,
    entrySignature,
    loadedIndicesRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    sideBySide,
    viewStateKey
  ])
}
