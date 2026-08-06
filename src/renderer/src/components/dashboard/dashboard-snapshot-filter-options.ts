import type { AppState } from '@/store/types'
import type { DashboardFilterOptions } from '../../../../shared/dashboard-snapshot'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import { boundedLabel } from './dashboard-card-labels'
import type { ActiveDashboardWorkspace } from './dashboard-snapshot-workspaces'

export function buildDashboardSnapshotFilterOptions(
  state: Partial<Pick<AppState, 'workspaceStatuses'>>,
  activeWorkspaces: ActiveDashboardWorkspace[]
): DashboardFilterOptions {
  const projects = [
    ...new Map(activeWorkspaces.map((workspace) => [workspace.projectId, workspace])).values()
  ].map((workspace) => ({
    id: workspace.projectId,
    label: boundedLabel(workspace.projectName)
  }))
  const workspaceStatuses = (
    state.workspaceStatuses && state.workspaceStatuses.length > 0
      ? state.workspaceStatuses
      : DEFAULT_WORKSPACE_STATUSES
  ).map((status) => ({
    id: status.id,
    label: status.label,
    color: status.color
  }))
  return { projects, workspaceStatuses }
}
