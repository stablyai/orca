import type { Repo } from '../../../../shared/repo-types'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from './workspace-creator-visibility'
import type { VisibleWorktreeOptions } from './visible-worktrees'
import { buildSidebarHostOptions } from './sidebar-host-options'
import {
  buildSidebarFilterQueryEvaluation,
  type SidebarFilterQueryEvaluation
} from './sidebar-filter-query-evaluation'
import { buildWorkspaceStatusLabelById } from './workspace-filter-subject'

/**
 * Read the store into the filter inputs `computeVisibleWorktrees` decides from.
 *
 * Why separate from the filter itself: this is the only part of the pipeline that touches the
 * store, so keeping it here leaves the filter a pure function of its options — which is what lets
 * the sidebar, Cmd+J and the Cmd+1–9 handler all reuse it without a React render.
 */
export function buildVisibleWorktreeOptionsFromState(
  state: ReturnType<typeof useAppStore.getState>,
  repoMap: Map<string, Repo>
): VisibleWorktreeOptions {
  return {
    filterRepoIds: state.filterRepoIds,
    showSleepingWorkspaces: state.showSleepingWorkspaces,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    browserTabsByWorktree: state.browserTabsByWorktree,
    worktreeIdsWithLiveAgent: getWorktreeIdsWithLiveAgent(
      state.agentStatusByPaneKey,
      state.tabsByWorktree,
      Date.now()
    ),
    worktreeIdsWithStructuredChat: getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree),
    hideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices: state.hideWorkspacesFromOtherDevices,
    pairedDeviceIdsByEnvironment: state.hideWorkspacesFromOtherDevices
      ? getPairedDeviceIdsByEnvironment(
          state.runtimeEnvironments,
          state.runtimeStatusByEnvironmentId
        )
      : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    alwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace,
    repoMap,
    workspaceHostScope: state.workspaceHostScope,
    visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
    defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
    worktreeLineageById: state.worktreeLineageById,
    filterQuery: buildSidebarFilterQueryEvaluationFromState(state, repoMap)
  }
}

/** Evaluates the typed query outside React; returns null when the field is blank. */
export function buildSidebarFilterQueryEvaluationFromState(
  state: ReturnType<typeof useAppStore.getState>,
  repoMap: Map<string, Repo>
): SidebarFilterQueryEvaluation | null {
  const query = state.sidebarFilterQuery ?? ''
  if (!query.trim()) {
    return null
  }
  const hostOptions = buildSidebarHostOptions({
    repos: state.repos,
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    settings: state.settings,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  return buildSidebarFilterQueryEvaluation({
    query,
    worktrees: getAllWorktreesFromState(state),
    repoMap,
    hostLabelById: new Map(hostOptions.map((host) => [host.id, host.label])),
    statusLabelById: buildWorkspaceStatusLabelById(state.workspaceStatuses),
    resolveHostId: (worktree, repo) => getWorktreeExecutionHostId(worktree, repo, defaultHostId)
  })
}
