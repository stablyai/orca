import type { Repo } from '../../../../../../shared/repo-types'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { useAppStore } from '@/store'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../../../shared/workspace-creator-visibility'
import type { VisibleWorktreeOptions } from './compute-visible-worktrees'
import { collectScopedAgentTypesByWorktree } from '../../workspace-agent-filter-evidence'

/** Isolate store reads so sidebar, palette and keyboard shortcuts can share the pure visibility filter. */
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
    worktreeIdsWithStructuredChat: getWorktreeIdsWithStructuredChat(
      state.unifiedTabsByWorktree,
      state.structuredChatSleptAtByPaneKey
    ),
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
    filterAgentIds: state.filterAgentIds,
    agentTypesByWorktree: collectScopedAgentTypesByWorktree({
      filterAgentIds: state.filterAgentIds,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      tabsByWorktree: state.tabsByWorktree,
      worktrees: Object.values(state.worktreesByRepo).flat()
    }),
    runtimePaneTitlesByTabId: state.filterAgentIds ? state.runtimePaneTitlesByTabId : null,
    terminalLayoutsByTabId: state.filterAgentIds ? state.terminalLayoutsByTabId : null,
    repoMap,
    workspaceHostScope: state.workspaceHostScope,
    visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
    defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
    worktreeLineageById: state.worktreeLineageById,
    preserveLineageParentOrder: state.sortBy === 'manual'
  }
}
