import React, { useCallback, useRef, useState } from 'react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffFileTreeMode } from '../resolve-changes/combined-diff-section-identity'
import { handleCombinedDiffFileTreeNavigation } from './combined-diff-file-tree-navigation'
import { isCombinedDiffSectionViewed } from './combined-diff-file-tree-filter'

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
  sections,
  sectionsRef,
  toggleSection,
  treeMode
}: {
  ensureSectionLoaded: (index: number) => void
  entrySignature: string
  markDirectScrollInput: () => void
  scrollToIndex: (index: number) => void
  // Share one identity-stable map with the viewer’s scroll anchor.
  sectionIndexByKey: ReadonlyMap<string, number>
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  toggleSection: (index: number) => void
  treeMode: CombinedDiffFileTreeMode
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
  const viewedSectionCacheRef = useRef<{
    entrySignature: string
    sections: DiffSection[]
    keys: Set<string>
  } | null>(null)
  const viewedSectionKeys = React.useMemo(() => {
    const recomputeAllViewedKeys = (): Set<string> => {
      const keys = new Set(
        sections
          .filter((section) => isCombinedDiffSectionViewed(section))
          .map((section) => section.key)
      )
      viewedSectionCacheRef.current = { entrySignature, sections, keys }
      return keys
    }
    const previous = viewedSectionCacheRef.current
    if (
      previous === null ||
      previous.entrySignature !== entrySignature ||
      previous.sections.length !== sections.length
    ) {
      return recomputeAllViewedKeys()
    }

    let keys = previous.keys
    let copied = false
    for (let index = 0; index < sections.length; index += 1) {
      const previousSection = previous.sections[index]
      const section = sections[index]
      if (!previousSection || !section) {
        continue
      }
      // Loads replace only their own section; identical row objects need no viewed-state derivation.
      if (previousSection === section) {
        continue
      }
      // Reordered keys require full recomputation or a later delete could erase an earlier addition.
      if (previousSection.key !== section.key) {
        return recomputeAllViewedKeys()
      }
      const viewed = isCombinedDiffSectionViewed(section)
      if (isCombinedDiffSectionViewed(previousSection) === viewed) {
        continue
      }
      if (!copied) {
        keys = new Set(previous.keys)
        copied = true
      }
      if (viewed) {
        keys.add(section.key)
      } else {
        keys.delete(section.key)
      }
    }
    viewedSectionCacheRef.current = { entrySignature, sections, keys }
    return keys
  }, [entrySignature, sections])
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
