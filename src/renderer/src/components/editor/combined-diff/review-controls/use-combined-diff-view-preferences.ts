import { useCallback, useState } from 'react'
import type React from 'react'
import type { DiffSection } from '../../diff-section-types'
import { combinedDiffViewPreferences } from '../remember-view/combined-diff-view-memory'
import { getInitialCombinedDiffSectionLoadIndices } from '../load-sections/combined-diff-initial-section-load'
import type { CombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'

export type CombinedDiffViewPreferences = {
  fileTreeCollapsed: boolean
  setAllSectionsCollapsed: (collapsed: boolean) => void
  setFileTreeCollapsed: (collapsed: boolean) => void
  setSideBySide: (sideBySide: boolean) => void
  sideBySide: boolean
  toggleDiffWordWrap: () => void
  toggleSideBySide: () => void
}

export function useCombinedDiffViewPreferences({
  combinedDiffFileTreeVisibleByDefault,
  diffDefaultView,
  diffWordWrap,
  registry,
  setSections,
  updateSettings
}: {
  combinedDiffFileTreeVisibleByDefault: boolean | undefined
  diffDefaultView: string | undefined
  diffWordWrap: boolean | undefined
  registry: CombinedDiffSectionLoadRegistry
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  updateSettings: (patch: { diffWordWrap: boolean }) => unknown
}): CombinedDiffViewPreferences {
  const { loadSchedulerRef, loadedIndicesRef, sectionsRef } = registry
  const [sideBySideOverride, setSideBySideOverride] = useState<boolean | null>(null)
  const sideBySide =
    sideBySideOverride ??
    combinedDiffViewPreferences.sideBySide ??
    diffDefaultView === 'side-by-side'
  const [fileTreeCollapsedOverride, setFileTreeCollapsedOverride] = useState<boolean | null>(null)
  // Why: the tree is opt-in; only an explicit saved setting should open it while settings are still loading.
  const fileTreeCollapsed =
    fileTreeCollapsedOverride ??
    combinedDiffViewPreferences.fileTreeCollapsed ??
    combinedDiffFileTreeVisibleByDefault !== true
  const setSideBySide = useCallback((next: boolean): void => {
    setSideBySideOverride(next)
  }, [])

  const setFileTreeCollapsed = useCallback((collapsed: boolean) => {
    combinedDiffViewPreferences.fileTreeCollapsed = collapsed
    setFileTreeCollapsedOverride(collapsed)
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
  }, [setSideBySide, sideBySide])

  const toggleDiffWordWrap = useCallback(() => {
    void updateSettings({ diffWordWrap: diffWordWrap !== true })
  }, [diffWordWrap, updateSettings])

  return {
    fileTreeCollapsed,
    setAllSectionsCollapsed,
    setFileTreeCollapsed,
    setSideBySide,
    sideBySide,
    toggleDiffWordWrap,
    toggleSideBySide
  }
}
