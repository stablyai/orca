import React from 'react'
import { Activity, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { selectWorktreeActivityStatuses } from '../../workspace-card/activity/use-worktree-activity-statuses'

type ProjectHeaderEntry = {
  collapseKey: string
  worktreeIds: readonly string[]
  /** Collapsed groups above a project that a collapsed group hides; opened to reveal it. */
  groupKeys: readonly string[]
}

function getHeaderEntries(rows: readonly HostSectionRow[]): {
  projects: ProjectHeaderEntry[]
  groups: string[]
} {
  const projects: ProjectHeaderEntry[] = []
  const groups: string[] = []
  for (const row of rows) {
    if (row.type !== 'header') {
      continue
    }
    const collapseKey = row.collapseKey ?? row.key
    if (row.repo !== undefined) {
      projects.push({ collapseKey, worktreeIds: row.worktreeIds ?? [], groupKeys: [] })
    } else if (row.projectGroup !== undefined) {
      groups.push(collapseKey)
      // A collapsed group's projects have no rows; its header lists them.
      for (const project of row.collapsedSubtree?.projects ?? []) {
        projects.push({
          collapseKey: project.key,
          worktreeIds: project.worktreeIds,
          groupKeys: project.groupKeys
        })
      }
      groups.push(...(row.collapsedSubtree?.groupKeys ?? []))
    }
  }
  return { projects, groups }
}

function updateCollapsedGroups(mutate: (next: Set<string>) => void): void {
  const state = useAppStore.getState()
  const next = new Set(state.collapsedGroups)
  mutate(next)
  state.setCollapsedGroups(next)
}

function collapseAllProjects(rows: readonly HostSectionRow[]): void {
  const { projects } = getHeaderEntries(rows)
  updateCollapsedGroups((next) => {
    for (const project of projects) {
      next.add(project.collapseKey)
    }
  })
}

function expandAllProjects(rows: readonly HostSectionRow[]): void {
  const { projects, groups } = getHeaderEntries(rows)
  updateCollapsedGroups((next) => {
    for (const key of [...projects.map((project) => project.collapseKey), ...groups]) {
      next.delete(key)
    }
  })
}

function expandActiveProjectsOnly(rows: readonly HostSectionRow[]): void {
  const { projects } = getHeaderEntries(rows)
  const state = useAppStore.getState()
  const activeWorktreeId = state.activeWorktreeId
  const statuses = selectWorktreeActivityStatuses(
    state,
    projects.flatMap((project) => project.worktreeIds)
  )
  // Why by key: a project on several hosts has one header per host section sharing a collapse key;
  // an idle copy must not re-collapse what an active copy opened.
  const activeProjectKeys = new Set(
    projects
      .filter((project) =>
        project.worktreeIds.some(
          (id) => id === activeWorktreeId || (statuses.get(id) ?? 'inactive') !== 'inactive'
        )
      )
      .map((project) => project.collapseKey)
  )
  updateCollapsedGroups((next) => {
    for (const project of projects) {
      if (activeProjectKeys.has(project.collapseKey)) {
        next.delete(project.collapseKey)
        for (const groupKey of project.groupKeys) {
          next.delete(groupKey)
        }
      } else {
        next.add(project.collapseKey)
      }
    }
  })
}

// Why: resolve headers and state at click time so the menus don't re-render on collapse or activity changes.
export function ProjectCollapseMenuItems({
  getRows
}: {
  getRows: () => readonly HostSectionRow[]
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => collapseAllProjects(getRows())}>
        <ChevronsDownUp className="size-3.5" />
        {translate('auto.components.sidebar.projectCollapse.collapseAll', 'Collapse all projects')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => expandAllProjects(getRows())}>
        <ChevronsUpDown className="size-3.5" />
        {translate('auto.components.sidebar.projectCollapse.expandAll', 'Expand all projects')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => expandActiveProjectsOnly(getRows())}>
        <Activity className="size-3.5" />
        {translate(
          'auto.components.sidebar.projectCollapse.expandActive',
          'Expand only active projects'
        )}
      </DropdownMenuItem>
    </>
  )
}
