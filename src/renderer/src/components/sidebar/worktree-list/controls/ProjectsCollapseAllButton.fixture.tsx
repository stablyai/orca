import { useState } from 'react'
import { createPortal } from 'react-dom'
import { defineFixture } from '@/component-fixtures/component-fixture'
import { ContextualTourOverlay } from '@/components/contextual-tours/ContextualTourOverlay'
import { Button } from '@/components/ui/button'
import SidebarHeader from '../../SidebarHeader'
import { useAppStore } from '@/store'
import { ProjectsCollapseAllButton } from './ProjectsCollapseAllButton'
import { useProjectsCollapseAllAnnouncement } from './use-projects-collapse-all-announcement'
import { useProjectsCollapseShortcut } from './use-projects-collapse-shortcut'

function CollapseControl() {
  const [collapsed, setCollapsed] = useState(false)
  const toggle = () => setCollapsed((value) => !value)
  useProjectsCollapseShortcut(true, toggle)
  return <ProjectsCollapseAllButton allCollapsed={collapsed} onToggle={toggle} />
}

function AnnouncedProjects() {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const sidebarBody = useAppStore((s) => s.sidebarBody)
  const announceProjectCollapse = useProjectsCollapseAllAnnouncement(Boolean(target))
  return (
    <div className="h-80 w-80 bg-worktree-sidebar">
      <SidebarHeader onWorkspaceBoardMenuOpenChange={() => {}} projectsCollapseTarget={setTarget} />
      {target && sidebarBody !== 'agents' ? createPortal(<CollapseControl />, target) : null}
      <Button
        variant="ghost"
        className="w-full justify-start"
        data-fixture-project=""
        onClick={() => {
          useAppStore.getState().toggleCollapsedGroup('repo:orca')
          announceProjectCollapse('repo:orca')
        }}
      >
        Orca
      </Button>
      <ContextualTourOverlay />
    </div>
  )
}

export const announcement = defineFixture({
  width: 760,
  store: {
    persistedUIReady: true,
    contextualToursAutoEligible: false,
    groupBy: 'repo',
    sidebarBody: 'workspaces'
  },
  render: () => <AnnouncedProjects />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('[data-fixture-project]')?.click()
})
