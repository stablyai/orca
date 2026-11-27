import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type {
  DashboardCard,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import type { DashboardAgentRow } from '../rows/dashboard-agent-row'
import type { DashboardSnapshotInput } from './build-dashboard-snapshot'
import type { DashboardCardContext } from './dashboard-card-context'
import { getTranslationScope } from '@/i18n/i18n'
import type { ActiveDashboardWorkspace } from './dashboard-snapshot-workspaces'

export type DashboardWorkspaceBuild = {
  start: number
  rows: Map<
    string,
    {
      row: DashboardAgentRow
      status: AgentStatusEntry | undefined
      activationStatus: AgentStatusEntry | undefined
      card: DashboardCard
    }
  >
  cards: DashboardCard[]
  context: DashboardCardContext | undefined
}

export type DashboardSnapshotReuse = {
  inputs: readonly unknown[]
  projection?: AgentStatusProjection
  cursor: number
  activeWorktrees: ActiveDashboardWorkspace[]
  workspaces: Map<ActiveDashboardWorkspace, DashboardWorkspaceBuild>
  workspacesById: Map<string, ActiveDashboardWorkspace[]>
  owners: Map<string, Set<string>>
  filterOptions: DashboardSnapshot['filterOptions']
  snapshot?: DashboardSnapshot
}

export function createDashboardSnapshotReuse(): DashboardSnapshotReuse {
  return {
    inputs: [],
    cursor: 0,
    activeWorktrees: [],
    workspaces: new Map(),
    workspacesById: new Map(),
    owners: new Map(),
    filterOptions: undefined
  }
}

/** Every non-status input invalidates host, review, title and workspace context together. */
export function dashboardSnapshotReuseInputs(state: DashboardSnapshotInput): unknown[] {
  return [
    getTranslationScope(),
    state.chatNames,
    state.repos,
    selectWorktreesByRepo(state),
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.migrationUnsupportedByPtyId,
    state.runtimeAgentOrchestrationByPaneKey,
    state.remoteAgentOrchestrationByHost,
    state.terminalLayoutsByTabId,
    state.ptyIdsByTabId,
    state.runtimePaneTitlesByTabId,
    state.acknowledgedAgentsByPaneKey,
    state.settings,
    state.hostedReviewCache,
    state.prCache,
    state.workspaceStatuses,
    selectDetectedWorktreesByRepo(state),
    selectFolderWorkspaces(state),
    state.projectGroups,
    state.sshTargetLabels,
    state.sshConnectionStates,
    state.sshStateByEnvironment,
    state.runtimeStatusByEnvironmentId,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.runtimeEnvironments,
    state.runtimeEnvironmentCatalogHydrated,
    state.removedRuntimeEnvironmentIds,
    state.paneForegroundAgentByPaneKey,
    state.agentLaunchConfigByPaneKey,
    state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId
  ]
}
