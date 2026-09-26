import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import type { DiffSection } from '../../diff-section-types'
import { combinedDiffViewPreferences } from '../remember-view/combined-diff-view-memory'
import { getInitialCombinedDiffSectionLoadIndices } from '../load-sections/combined-diff-initial-section-load'
import type { CombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'

export type CombinedDiffViewPreferences = {
  fileTreeCollapsed: boolean
  setAllSectionsCollapsed: (collapsed: boolean) => void
  setFileTreeCollapsed: (collapsed: boolean) => void
  setSideBySide: React.Dispatch<React.SetStateAction<boolean>>
  sideBySide: boolean
  toggleDiffShowWhitespace: () => void
  toggleDiffWordWrap: () => void
  toggleSideBySide: () => void
}

export function useCombinedDiffViewPreferences({
  combinedDiffFileTreeVisibleByDefault,
  diffDefaultView,
  diffShowWhitespace,
  diffWordWrap,
  registry,
  setSections,
  updateSettings
}: {
  combinedDiffFileTreeVisibleByDefault: boolean | undefined
  diffDefaultView: string | undefined
  diffShowWhitespace: boolean | undefined
  diffWordWrap: boolean | undefined
  registry: CombinedDiffSectionLoadRegistry
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  updateSettings: (patch: { diffShowWhitespace?: boolean; diffWordWrap?: boolean }) => unknown
}): CombinedDiffViewPreferences {
  const { loadSchedulerRef, loadedIndicesRef, sectionsRef } = registry
  const [sideBySide, setSideBySide] = useState(
    () => combinedDiffViewPreferences.sideBySide ?? diffDefaultView === 'side-by-side'
  )
  const [fileTreeCollapsed, setFileTreeCollapsedState] = useState(
    () =>
      // Why: the tree is opt-in; only an explicit saved setting should open it while settings are still loading.
      combinedDiffViewPreferences.fileTreeCollapsed ?? combinedDiffFileTreeVisibleByDefault !== true
  )

  // Why: seed from Settings until the user picks a toolbar mode this session, then follow that choice over the global default.
  useEffect(() => {
    if (diffDefaultView !== undefined && combinedDiffViewPreferences.sideBySide === null) {
      setSideBySide(diffDefaultView === 'side-by-side')
    }
  }, [diffDefaultView])

  useEffect(() => {
    if (
      combinedDiffFileTreeVisibleByDefault !== undefined &&
      combinedDiffViewPreferences.fileTreeCollapsed === null
    ) {
      setFileTreeCollapsedState(combinedDiffFileTreeVisibleByDefault === false)
    }
  }, [combinedDiffFileTreeVisibleByDefault])

  const setFileTreeCollapsed = useCallback((collapsed: boolean) => {
    combinedDiffViewPreferences.fileTreeCollapsed = collapsed
    setFileTreeCollapsedState(collapsed)
  }, [])

  const setAllSectionsCollapsed = useCallback(
    (collapsed: boolean) => {
      combinedDiffViewPreferences.collapsed = collapsed
      setSections((prev) => prev.map((section) => ({ ...section, collapsed })))
      if (!collapsed) {
        const initialIndices = getInitialCombinedDiffSectionLoadIndices({
          sectionCount: sectionsRef.current.length,
          loadedIndices: loadedIndicesRef.current
        })
        for (const index of initialIndices) {
          loadSchedulerRef.current.request(index)
        }
      }
    },
    [loadSchedulerRef, loadedIndicesRef, sectionsRef, setSections]
  )

  const toggleSideBySide = useCallback(() => {
    // Why: React may replay a state updater, so the module preference is written here rather than inside it.
    const next = !sideBySide
    combinedDiffViewPreferences.sideBySide = next
    setSideBySide(next)
  }, [sideBySide])

  const toggleDiffWordWrap = useCallback(() => {
    void updateSettings({ diffWordWrap: diffWordWrap !== true })
  }, [diffWordWrap, updateSettings])

  const toggleDiffShowWhitespace = useCallback(() => {
    void updateSettings({ diffShowWhitespace: diffShowWhitespace !== true })
  }, [diffShowWhitespace, updateSettings])

  return {
    fileTreeCollapsed,
    setAllSectionsCollapsed,
    setFileTreeCollapsed,
    setSideBySide,
    sideBySide,
    toggleDiffShowWhitespace,
    toggleDiffWordWrap,
    toggleSideBySide
  }
}
