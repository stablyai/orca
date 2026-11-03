import { getRepoMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import { computeVisibleWorktrees } from './compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set()

function getProjectHeaderCollapseKeys(
  state: AppState,
  collapsedGroups: ReadonlySet<string>
): string[] {
  const visibleWorktrees = computeVisibleWorktrees(
    selectWorktreesByRepo(state),
    [],
    buildVisibleWorktreeOptionsFromState(state, getRepoMapFromState(state))
  )
  const rows = computeRenderedSidebarRows(
    { ...state, collapsedGroups: new Set(collapsedGroups) },
    visibleWorktrees
  )
  const keys = new Set<string>()
  for (const row of rows) {
    // Same rows SectionHeader gives a chevron: project and project-group headers with workspaces.
    if (row.type === 'header' && row.count > 0 && (row.repo || row.projectGroup)) {
      keys.add(row.collapseKey ?? row.key)
    }
  }
  return [...keys]
}

/** Keys to flip so every project header ends collapsed, or expanded when all visible ones already are. */
export function resolveProjectCollapseAllToggleKeys(state: AppState): string[] {
  if (state.groupBy !== 'repo') {
    return []
  }
  const { collapsedGroups } = state
  // Decide from visible headers so ones hidden under a collapsed group cannot block expand-all.
  const anyExpanded = getProjectHeaderCollapseKeys(state, collapsedGroups).some(
    (key) => !collapsedGroups.has(key)
  )
  return getProjectHeaderCollapseKeys(state, NO_COLLAPSED_GROUPS).filter(
    (key) => collapsedGroups.has(key) !== anyExpanded
  )
}
