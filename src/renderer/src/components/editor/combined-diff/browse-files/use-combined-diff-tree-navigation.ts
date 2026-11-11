import React, { useCallback, useRef, useState } from 'react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import type { CombinedDiffFileTreeMode } from '../resolve-changes/combined-diff-section-identity'
import { handleCombinedDiffFileTreeNavigation } from './combined-diff-file-tree-navigation'

export type CombinedDiffTreeNavigation = {
  activeTreeSectionKey: string | null
  handleTreeNavigate: (entry: GitStatusEntry | GitBranchChangeEntry) => void
  sectionIndexByKey: ReadonlyMap<string, number>
  sectionIndexByKeyRef: React.RefObject<ReadonlyMap<string, number>>
  viewedSectionKeys: Set<string>
}

// Inject navigation targets to keep this module a leaf of the tree folder.
export function useCombinedDiffTreeNavigation({
  ensureSectionLoaded,
  entrySignature,
  markDirectScrollInput,
  scrollToIndex,
  sectionIndexByKey,
  sectionsRef,
  toggleSection,
  treeMode,
  viewedSectionKeys
}: {
  ensureSectionLoaded: (index: number) => void
  entrySignature: string
  markDirectScrollInput: () => void
  scrollToIndex: (index: number) => void
  // Share one identity-stable map with the viewer’s scroll anchor.
  sectionIndexByKey: ReadonlyMap<string, number>
  sectionsRef: React.RefObject<DiffSection[]>
  toggleSection: (index: number) => void
  treeMode: CombinedDiffFileTreeMode
  viewedSectionKeys: Set<string>
}): CombinedDiffTreeNavigation {
  const sectionIndexByKeyRef = useRef<ReadonlyMap<string, number>>(sectionIndexByKey)
  sectionIndexByKeyRef.current = sectionIndexByKey

  const [activeTreeSectionState, setActiveTreeSectionState] = useState<{
    entrySignature: string
    key: string | null
  }>(() => ({ entrySignature, key: null }))
  const activeTreeSectionKey =
    activeTreeSectionState.entrySignature === entrySignature ? activeTreeSectionState.key : null
  if (activeTreeSectionState.entrySignature !== entrySignature) {
    // Reset before paint so another entry set cannot inherit a stale highlight.
    setActiveTreeSectionState({ entrySignature, key: null })
  }
  const handleTreeNavigate = useCallback(
    (entry: GitStatusEntry | GitBranchChangeEntry) => {
      markDirectScrollInput()
      const navigatedIndex = handleCombinedDiffFileTreeNavigation({
        mode: treeMode,
        entry,
        sections: sectionsRef.current,
        sectionIndexByKey,
        toggleSection,
        loadSection: ensureSectionLoaded,
        scrollToIndex
      })
      if (navigatedIndex !== null) {
        setActiveTreeSectionState({
          entrySignature,
          key: sectionsRef.current[navigatedIndex]?.key ?? null
        })
      }
    },
    [
      ensureSectionLoaded,
      entrySignature,
      markDirectScrollInput,
      scrollToIndex,
      sectionIndexByKey,
      sectionsRef,
      toggleSection,
      treeMode
    ]
  )

  return {
    activeTreeSectionKey,
    handleTreeNavigate,
    sectionIndexByKey,
    sectionIndexByKeyRef,
    viewedSectionKeys
  }
}
