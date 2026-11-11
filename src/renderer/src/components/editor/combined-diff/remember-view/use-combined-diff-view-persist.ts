import { useEffect } from 'react'
import type React from 'react'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { rememberCombinedDiffView, type CombinedDiffViewLease } from './combined-diff-view-cache'

export function useCombinedDiffViewPersist({
  combinedGitStatusSignature,
  entryCount,
  entrySignature,
  memoryLeaseRef,
  sectionHeights,
  sections,
  loadedIndicesRef
}: {
  combinedGitStatusSignature: string
  entryCount: number
  entrySignature: string
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  loadedIndicesRef: React.RefObject<Set<number>>
}): void {
  useEffect(() => {
    if (sections.length === 0 && entryCount > 0) {
      return
    }
    rememberCombinedDiffView(memoryLeaseRef.current, {
      view: {
        entrySignature,
        gitStatusSignature: combinedGitStatusSignature,
        sections,
        sectionHeights,
        loadedIndices: Array.from(loadedIndicesRef.current).filter(
          (index) => !sections[index]?.loading
        )
      }
    })
  }, [
    combinedGitStatusSignature,
    entryCount,
    entrySignature,
    loadedIndicesRef,
    memoryLeaseRef,
    sectionHeights,
    sections
  ])
}
