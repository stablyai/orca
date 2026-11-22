import { useLayoutEffect } from 'react'
import type { editor } from 'monaco-editor'
import type React from 'react'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import {
  readCombinedDiffViewMemory,
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from './combined-diff-view-cache'
import {
  liveCombinedDiffModelEdits,
  registerMountedCombinedDiffDrafts
} from './combined-diff-close-drafts'

export function useCombinedDiffViewPersist({
  combinedGitStatusSignature,
  entryCount,
  entrySignature,
  memoryLeaseRef,
  scrollContainerRef,
  sectionHeights,
  sections,
  sectionsRef,
  modifiedEditorsRef,
  loadedIndicesRef,
  viewStateKey
}: {
  combinedGitStatusSignature: string
  entryCount: number
  entrySignature: string
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  modifiedEditorsRef: React.RefObject<Map<number, editor.IStandaloneCodeEditor>>
  loadedIndicesRef: React.RefObject<Set<number>>
  viewStateKey: string
}): void {
  useLayoutEffect(() => {
    const lease = memoryLeaseRef.current
    if (!lease) {
      return
    }
    return registerMountedCombinedDiffDrafts(lease, () =>
      sectionsRef.current.map((section, index) => {
        const editor = modifiedEditorsRef.current.get(index)
        const content = editor && liveCombinedDiffModelEdits.get(editor)
        if (content === undefined || content === section.modifiedContent) {
          return section
        }
        const baseline =
          section.diffResult?.kind === 'text'
            ? section.diffResult.modifiedContent
            : section.modifiedContent
        return { ...section, modifiedContent: content, dirty: content !== baseline }
      })
    )
  }, [memoryLeaseRef, modifiedEditorsRef, sectionsRef, viewStateKey])

  useLayoutEffect(() => {
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
        )
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
    viewStateKey
  ])
}
