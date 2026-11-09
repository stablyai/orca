import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  getProjectGroupHeaderKey,
  isProjectSectionGroupKey
} from '../../../../../../shared/sidebar-list/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import { useProjectsCollapseShortcut } from '../controls/use-projects-collapse-shortcut'
import { useProjectsCollapseAllAnnouncement } from '../controls/use-projects-collapse-all-announcement'
import {
  areAllProjectsCollapsed,
  getRenderedProjectCollapseKeys,
  setAllProjectsCollapsed
} from './project-collapse-all'

export function useProjectSectionCollapseControls(args: {
  groupBy: WorktreeGroupBy
  sectionRows: readonly HostSectionRow[]
  occurrenceSectionKeys: readonly string[]
  visibleProjectGroups: readonly ProjectGroup[]
  effectiveCollapsedGroups: ReadonlySet<string>
  filtersHideAllRows: boolean
  hasCollapseTarget: boolean
}) {
  const {
    groupBy,
    sectionRows,
    occurrenceSectionKeys,
    visibleProjectGroups,
    effectiveCollapsedGroups,
    filtersHideAllRows,
    hasCollapseTarget
  } = args
  const toggleGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const setCollapsedGroups = useAppStore((s) => s.setCollapsedGroups)

  const projectCollapseKeys = useMemo(
    () => (groupBy === 'repo' ? getRenderedProjectCollapseKeys(sectionRows) : []),
    [groupBy, sectionRows]
  )
  const projectSectionCount = useMemo(
    () =>
      new Set([
        ...occurrenceSectionKeys.filter(isProjectSectionGroupKey),
        ...visibleProjectGroups.map(({ id }) => getProjectGroupHeaderKey(id))
      ]).size,
    [occurrenceSectionKeys, visibleProjectGroups]
  )
  const allProjectsCollapsed = areAllProjectsCollapsed(
    projectCollapseKeys,
    effectiveCollapsedGroups
  )
  const handleToggleAllProjects = useCallback(() => {
    void useAppStore.getState().recordFeatureInteraction('projects-collapse-all')
    // Direction follows what is displayed, which may differ from stored state while a picker forces sections open.
    setCollapsedGroups(
      setAllProjectsCollapsed(
        useAppStore.getState().collapsedGroups,
        projectCollapseKeys,
        !allProjectsCollapsed
      )
    )
  }, [allProjectsCollapsed, projectCollapseKeys, setCollapsedGroups])

  const handleExpandGroupKey = useCallback(
    (groupKey: string) => {
      const current = useAppStore.getState().collapsedGroups
      if (!current.has(groupKey)) {
        return
      }
      const next = new Set(current)
      next.delete(groupKey)
      setCollapsedGroups(next)
    },
    [setCollapsedGroups]
  )

  useProjectsCollapseShortcut(
    projectCollapseKeys.length > 0 && !filtersHideAllRows,
    handleToggleAllProjects
  )
  const announceProjectCollapse = useProjectsCollapseAllAnnouncement(
    hasCollapseTarget && groupBy === 'repo' && projectSectionCount > 1 && !filtersHideAllRows
  )
  const handleToggleGroup = useCallback(
    (groupKey: string) => {
      toggleGroup(groupKey)
      announceProjectCollapse(groupKey)
    },
    [announceProjectCollapse, toggleGroup]
  )

  return {
    projectCollapseKeys,
    allProjectsCollapsed,
    handleToggleAllProjects,
    handleExpandGroupKey,
    handleToggleGroup
  }
}
