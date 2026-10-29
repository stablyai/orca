import { useEffect } from 'react'
import type React from 'react'
import type { DiffSection } from '../../diff-section-types'
import {
  readCombinedDiffViewMemory,
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from './combined-diff-view-cache'

export function useCombinedDiffViewPersist({
  combinedGitStatusSignature,
  entryCount,
  entrySignature,
  memoryLeaseRef,
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
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
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
    rememberCombinedDiffView(memoryLeaseRef.current, {
      scrollTop:
        readCombinedDiffViewMemory(viewStateKey)?.scrollTop ??
        scrollContainerRef.current?.scrollTop ??
        0,
      view: {
        entrySignature,
        gitStatusSignature: combinedGitStatusSignature,
        sections,
        sectionHeights,
        loadedIndices: Array.from(loadedIndicesRef.current).filter(
          (index) => !sections[index]?.loading
        ),
        sideBySide
      }
    })
  }, [
    combinedGitStatusSignature,
    entryCount,
    entrySignature,
    loadedIndicesRef,
    memoryLeaseRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    sideBySide,
    viewStateKey
  ])
}
