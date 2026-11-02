import React, { useContext, useMemo } from 'react'
import { useAppStore } from '@/store'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { SidebarHostOptionsContext } from './sidebar-host-options-context'
import { getProjectGroupHostContexts } from './worktree-list/rows/project-header-host-context'
import { ProjectHeaderHostLabel } from './worktree-list/rows/ProjectHeaderHostLabel'

/** Move to group targets; each names its computer once the groups come from several. */
export function ProjectGroupMoveMenuItems({
  projectGroups,
  currentGroupId,
  onMove
}: {
  projectGroups: readonly ProjectGroup[]
  currentGroupId: string | null | undefined
  onMove: (groupId: string) => void
}): React.JSX.Element {
  // Mounted only while the submenu is open, so cards do not each subscribe to host state.
  const hostOptions = useContext(SidebarHostOptionsContext)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  // Why: outside the sidebar (Kanban, folder panel) there is no registry, and a bare host id is no name.
  const hostContexts = useMemo(
    () =>
      hostOptions
        ? getProjectGroupHostContexts({
            groups: projectGroups,
            hosts: hostOptions,
            runtimeEnvironments,
            sshConnectionStates
          })
        : null,
    [projectGroups, hostOptions, runtimeEnvironments, sshConnectionStates]
  )
  return (
    <>
      {projectGroups.map((group, index) => {
        const host = hostContexts?.[index]
        return (
          <DropdownMenuItem
            key={`${group.executionHostId ?? group.connectionId ?? ''}:${group.id}`}
            disabled={currentGroupId === group.id}
            onSelect={() => onMove(group.id)}
          >
            <span className="max-w-48 truncate">{group.name}</span>
            {/* Fixed cap: a half-width cap on a shrink-to-fit menu row clips even short names. */}
            {host ? <ProjectHeaderHostLabel context={host} className="max-w-48" /> : null}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
