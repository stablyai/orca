import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import { filterDashboardWorkspaces, type DashboardFilters } from './agent-board-filtering'
import { agentMapWorktreeIdentityFromParts } from './agent-map-workspace-identity'

export function selectAgentlessMapWorkspaces({
  cards,
  workspaces,
  query,
  filters
}: {
  cards: DashboardCard[]
  workspaces: DashboardWorkspace[]
  query: string
  filters: DashboardFilters
}): DashboardWorkspace[] {
  const occupiedWorkspaceIds = new Set(
    cards.map((card) => agentMapWorktreeIdentityFromParts(card.worktreeId, card.executionHostId))
  )
  return filterDashboardWorkspaces(workspaces, query, filters).filter(
    (workspace) =>
      !occupiedWorkspaceIds.has(
        agentMapWorktreeIdentityFromParts(workspace.worktreeId, workspace.executionHostId)
      )
  )
}
