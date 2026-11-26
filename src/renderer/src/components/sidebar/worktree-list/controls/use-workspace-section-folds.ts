import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  replaceWorkspaceSectionFolds,
  workspaceSectionFoldKey,
  workspaceSectionFolds,
  type WorkspaceListSection
} from '../../../../../../shared/sidebar-list/sections/workspace-section-folds'

export function useWorkspaceSectionFolds(section: WorkspaceListSection) {
  const stored = useAppStore((state) => state.collapsedGroups)
  const collapsedGroups = useMemo(() => workspaceSectionFolds(stored, section), [stored, section])
  const toggleGroup = useCallback(
    (key: string) =>
      useAppStore.getState().toggleCollapsedGroup(workspaceSectionFoldKey(section, key)),
    [section]
  )
  const setCollapsedGroups = useCallback(
    (update: (current: Set<string>) => Set<string>) => {
      const state = useAppStore.getState()
      const next = update(workspaceSectionFolds(state.collapsedGroups, section))
      state.setCollapsedGroups(replaceWorkspaceSectionFolds(state.collapsedGroups, next, section))
    },
    [section]
  )
  return { collapsedGroups, toggleGroup, setCollapsedGroups }
}
