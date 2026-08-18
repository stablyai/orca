import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import { agentName } from './agent-map-agent-name'

export function agentMapCardTopologyIdentity(card: DashboardCard): string {
  const parentPaneKey = card.parentPaneKey ?? ''
  const parentWorktreeId = card.parentWorktreeId ?? ''
  const executionHostId = card.executionHostId ?? ''
  const name = agentName(card)
  return `${card.repoId.length}:${card.repoId}${card.worktreeId.length}:${card.worktreeId}${executionHostId.length}:${executionHostId}${card.paneKey.length}:${card.paneKey}${parentPaneKey.length}:${parentPaneKey}${parentWorktreeId.length}:${parentWorktreeId}${name.length}:${name}`
}

export function agentMapWorkspaceTopologyIdentity(workspace: DashboardWorkspace): string {
  const parentWorktreeId = workspace.parentWorktreeId ?? ''
  return `${workspace.repoId.length}:${workspace.repoId}${workspace.worktreeId.length}:${workspace.worktreeId}${workspace.executionHostId.length}:${workspace.executionHostId}${parentWorktreeId.length}:${parentWorktreeId}`
}

export function agentMapWorktreeIdentityFromParts(
  worktreeId: string,
  executionHostId: DashboardCard['executionHostId']
): string {
  const hostId = executionHostId ?? ''
  return `${worktreeId.length}:${worktreeId}${hostId.length}:${hostId}`
}

export function agentMapWorktreeIdentity(card: DashboardCard): string {
  return agentMapWorktreeIdentityFromParts(card.worktreeId, card.executionHostId)
}

export function agentMapWorkspaceIdentity(workspace: DashboardWorkspace): string {
  return agentMapWorktreeIdentityFromParts(workspace.worktreeId, workspace.executionHostId)
}
