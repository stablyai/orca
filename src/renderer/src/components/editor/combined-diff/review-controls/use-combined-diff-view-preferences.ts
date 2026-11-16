import { useCallback, useState } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { combinedDiffViewPreferences } from '../remember-view/combined-diff-view-memory'
import { getInitialCombinedDiffSectionLoadIndices } from '../load-sections/combined-diff-initial-section-load'
import type { CombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'

type DiffViewSettings = Pick<
  GlobalSettings,
  'diffDefaultView' | 'diffShowWhitespace' | 'diffWordWrap'
>

export type CombinedDiffViewPreferences = {
  fileTreeCollapsed: boolean
  setAllSectionsCollapsed: (collapsed: boolean) => void
  setFileTreeCollapsed: (collapsed: boolean) => void
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
  diffDefaultView: DiffViewSettings['diffDefaultView'] | undefined
  diffShowWhitespace: boolean | undefined
  diffWordWrap: boolean | undefined
  registry: CombinedDiffSectionLoadRegistry
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  updateSettings: (patch: Partial<DiffViewSettings>) => unknown
}): CombinedDiffViewPreferences {
  const { loadSchedulerRef, loadedIndicesRef, sectionsRef } = registry
  const sideBySide = diffDefaultView === 'side-by-side'
  const [fileTreeCollapsed, setFileTreeCollapsedState] = useState(
    () =>
      // While settings load, open the opt-in tree only for an explicit saved preference.
      combinedDiffViewPreferences.fileTreeCollapsed ?? combinedDiffFileTreeVisibleByDefault !== true
  )

  const [prevFileTreeVisibleByDefault, setPrevFileTreeVisibleByDefault] = useState(
    combinedDiffFileTreeVisibleByDefault
  )
  if (prevFileTreeVisibleByDefault !== combinedDiffFileTreeVisibleByDefault) {
    setPrevFileTreeVisibleByDefault(combinedDiffFileTreeVisibleByDefault)
    if (
      combinedDiffFileTreeVisibleByDefault !== undefined &&
      combinedDiffViewPreferences.fileTreeCollapsed === null
    ) {
      setFileTreeCollapsedState(combinedDiffFileTreeVisibleByDefault === false)
    }
  }

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
    void updateSettings({ diffDefaultView: sideBySide ? 'inline' : 'side-by-side' })
  }, [sideBySide, updateSettings])

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
    sideBySide,
    toggleDiffShowWhitespace,
    toggleDiffWordWrap,
    toggleSideBySide
  }
}
