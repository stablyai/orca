import React from 'react'
import { Activity } from 'lucide-react'
import { useAppStore } from '@/store'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { selectWorktreeActivityStatuses } from '../../workspace-card/activity/use-worktree-activity-statuses'

type ProjectHeaderEntry = {
  collapseKey: string
  worktreeIds: readonly string[]
  /** Collapsed groups above a project that a collapsed group hides; opened to reveal it. */
  groupKeys: readonly string[]
}

function getProjectEntries(rows: readonly HostSectionRow[]): ProjectHeaderEntry[] {
  const projects: ProjectHeaderEntry[] = []
  for (const row of rows) {
    if (row.type !== 'header') {
      continue
    }
    const collapseKey = row.collapseKey ?? row.key
    if (row.repo !== undefined) {
      projects.push({ collapseKey, worktreeIds: row.worktreeIds ?? [], groupKeys: [] })
    } else if (row.projectGroup !== undefined) {
      // A collapsed group's projects have no rows; its header lists them.
      for (const project of row.collapsedSubtree?.projects ?? []) {
        projects.push({
          collapseKey: project.key,
          worktreeIds: project.worktreeIds,
          groupKeys: project.groupKeys
        })
      }
    }
  }
  return projects
}

function expandActiveProjectsOnly(rows: readonly HostSectionRow[]): void {
  const projects = getProjectEntries(rows)
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
  const next = new Set(state.collapsedGroups)
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
  state.setCollapsedGroups(next)
}

// Why: resolve headers and state at click time so the menus don't re-render on collapse or activity changes.
export function ProjectCollapseMenuItems({
  getRows
}: {
  getRows: () => readonly HostSectionRow[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => expandActiveProjectsOnly(getRows())}>
        <Activity className="size-3.5" />
        {t('auto.components.sidebar.projectCollapse.expandActive', 'Expand only active projects')}
      </DropdownMenuItem>
    </>
  )
}
