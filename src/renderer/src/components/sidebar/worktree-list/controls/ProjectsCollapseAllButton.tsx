import React from 'react'
import { useShortcutKeyDetails } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { SectionCollapseAllButton } from './SectionCollapseAllButton'

const PROJECTS_TOGGLE_ATTRIBUTES = {
  'data-projects-collapse-toggle': ''
} as const

export function ProjectsCollapseAllButton({
  allCollapsed,
  onToggle
}: {
  allCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutKeyDetails('sidebar.projects.toggleCollapse')
  const announcing = useAppStore((s) => s.activeContextualTourId === 'projects-collapse-all')
  return (
    <SectionCollapseAllButton
      allCollapsed={allCollapsed}
      onToggle={onToggle}
      collapseLabel={t(
        'auto.components.sidebar.SidebarHeader.collapseAllProjects',
        'Collapse all projects'
      )}
      expandLabel={t(
        'auto.components.sidebar.SidebarHeader.expandAllProjects',
        'Expand all projects'
      )}
      shortcut={shortcut}
      announcing={announcing}
      toggleAttributes={PROJECTS_TOGGLE_ATTRIBUTES}
    />
  )
}
