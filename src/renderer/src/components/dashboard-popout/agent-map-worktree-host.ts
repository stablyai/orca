import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function agentMapWorktreeHost(
  cards: DashboardCard[],
  workspace?: DashboardWorkspace
): {
  executionHostId: DashboardCard['executionHostId']
  hostKind: DashboardCard['hostKind']
  hostLabel: DashboardCard['hostLabel']
} {
  const executionHostId = workspace?.executionHostId ?? cards[0]?.executionHostId
  const parsedHost = parseExecutionHostId(executionHostId)
  const hostKind =
    parsedHost?.kind === 'ssh'
      ? 'ssh'
      : parsedHost?.kind === 'runtime'
        ? 'remote'
        : (workspace?.hostKind ?? cards[0]?.hostKind)
  return {
    executionHostId,
    hostKind,
    hostLabel: workspace?.hostLabel ?? cards[0]?.hostLabel
  }
}
