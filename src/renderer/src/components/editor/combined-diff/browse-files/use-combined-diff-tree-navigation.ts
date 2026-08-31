import React, { useCallback, useRef, useState } from 'react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import {
  createCombinedDiffSectionIndexMap,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'
import { handleCombinedDiffFileTreeNavigation } from './combined-diff-file-tree-navigation'
import { isCombinedDiffSectionViewed } from './combined-diff-file-tree-filter'

export type CombinedDiffTreeNavigation = {
  activeTreeSectionKey: string | null
  handleTreeNavigate: (entry: GitStatusEntry | GitBranchChangeEntry) => void
  sectionIndexByKey: Map<string, number>
  sectionIndexByKeyRef: React.RefObject<ReadonlyMap<string, number>>
  viewedSectionKeys: Set<string>
}

// Why: navigation targets are passed in rather than imported so this stays a leaf of the tree folder.
export function useCombinedDiffTreeNavigation({
  ensureSectionLoaded,
  entrySignature,
  markDirectScrollInput,
  scrollToIndex,
  sections,
  sectionsRef,
  toggleSection,
  treeMode
}: {
  ensureSectionLoaded: (index: number) => void
  entrySignature: string
  markDirectScrollInput: () => void
  scrollToIndex: (index: number) => void
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  toggleSection: (index: number) => void
  treeMode: CombinedDiffFileTreeMode
}): CombinedDiffTreeNavigation {
  const sectionIndexByKey = React.useMemo(
    () => createCombinedDiffSectionIndexMap(sections),
    [sections]
  )
  const sectionIndexByKeyRef = useRef<ReadonlyMap<string, number>>(sectionIndexByKey)
  sectionIndexByKeyRef.current = sectionIndexByKey

  const [activeTreeSectionState, setActiveTreeSectionState] = useState<{
    entrySignature: string
    key: string | null
  }>(() => ({ entrySignature, key: null }))
  const activeTreeSectionKey =
    activeTreeSectionState.entrySignature === entrySignature ? activeTreeSectionState.key : null
  if (activeTreeSectionState.entrySignature !== entrySignature) {
    // Why: the tree highlight belongs to one entry set; reset now so it can't flash on another before an Effect would.
    setActiveTreeSectionState({ entrySignature, key: null })
  }
  const viewedSectionKeys = React.useMemo(
    () =>
      new Set(
        sections
          .filter((section) => isCombinedDiffSectionViewed(section))
          .map((section) => section.key)
      ),
    [sections]
  )
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
