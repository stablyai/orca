import React from 'react'
import { createPortal } from 'react-dom'
import { NewProjectGroupButton } from './NewProjectGroupButton'
import { ProjectsCollapseAllButton } from './ProjectsCollapseAllButton'

export function WorktreeListHeaderPortals({
  projectsCollapseTarget,
  showProjectsCollapseToggle,
  allProjectsCollapsed,
  onToggleAllProjects,
  newProjectGroupTarget,
  showNewProjectGroupButton,
  onCreateProjectGroup
}: {
  projectsCollapseTarget?: HTMLElement | null
  showProjectsCollapseToggle: boolean
  allProjectsCollapsed: boolean
  onToggleAllProjects: () => void
  newProjectGroupTarget?: HTMLElement | null
  showNewProjectGroupButton: boolean
  onCreateProjectGroup: () => void
}): React.JSX.Element {
  return (
    <>
      {projectsCollapseTarget && showProjectsCollapseToggle
        ? createPortal(
            <ProjectsCollapseAllButton
              allCollapsed={allProjectsCollapsed}
              onToggle={onToggleAllProjects}
            />,
            projectsCollapseTarget
          )
        : null}
      {newProjectGroupTarget && showNewProjectGroupButton
        ? createPortal(
            <NewProjectGroupButton preserveWorkspaceBoardOpen onCreate={onCreateProjectGroup} />,
            newProjectGroupTarget
          )
        : null}
    </>
  )
}
