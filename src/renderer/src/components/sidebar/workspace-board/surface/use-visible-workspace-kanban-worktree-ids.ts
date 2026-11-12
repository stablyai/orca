import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import '../../worktree-list/listing/visible-worktrees'
import { computeVisibleWorktrees } from '../../worktree-list/listing/compute-visible-worktrees'
import { createLiveAgentWorktreeIdsSelector } from '@/lib/workspace/activity/worktree-activity-state'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../../../shared/workspace-creator-visibility'
import { getStructuredChatWorktreeIds } from '../../worktree-list/listing/visible-worktree-activity-inputs'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { indexHiddenRepoRows } from '../../../../../../shared/hidden-projects'

type UseVisibleWorkspaceKanbanWorktreeIdsParams = {
  allWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
}

const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()
const EMPTY_RUNTIME_ENVIRONMENTS: AppState['runtimeEnvironments'] = []
const EMPTY_RUNTIME_STATUS_BY_ENVIRONMENT_ID: AppState['runtimeStatusByEnvironmentId'] = new Map()

export function useVisibleWorkspaceKanbanWorktreeIds({
  allWorktrees,
  repoMap
}: UseVisibleWorkspaceKanbanWorktreeIdsParams): ReadonlySet<string> {
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const repos = useAppStore((s) => s.repos)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const runtimeEnvironments = useAppStore((s) =>
    s.hideWorkspacesFromOtherDevices ? s.runtimeEnvironments : EMPTY_RUNTIME_ENVIRONMENTS
  )
  const runtimeStatusByEnvironmentId = useAppStore((s) =>
    s.hideWorkspacesFromOtherDevices
      ? s.runtimeStatusByEnvironmentId
      : EMPTY_RUNTIME_STATUS_BY_ENVIRONMENT_ID
  )
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const settings = useAppStore((s) => s.settings)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const tabsByWorktree = useAppStore((s) => (!showSleepingWorkspaces ? s.tabsByWorktree : null))
  const ptyIdsByTabId = useAppStore((s) => (!showSleepingWorkspaces ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    !showSleepingWorkspaces ? s.browserTabsByWorktree : null
  )
  const worktreeIdsWithStructuredChat = useAppStore((s) =>
    getStructuredChatWorktreeIds(
      showSleepingWorkspaces,
      s.unifiedTabsByWorktree,
      s.structuredChatSleptAtByPaneKey
    )
  )
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  // Skip the shared clock for opt-out boards so they cannot evict the live-board sample.
  const agentStatusNow = showSleepingWorkspaces ? 0 : getAgentStatusEpochNow(agentStatusEpoch)
  // Recompute on epoch, not every hook ping; key on the epoch too since ticks can share a millisecond sample.
  const [selectLiveAgentWorktreeIds] = useState(createLiveAgentWorktreeIdsSelector)
  const worktreeIdsWithLiveAgent = useAppStore((s) =>
    showSleepingWorkspaces
      ? EMPTY_WORKTREE_ID_SET
      : selectLiveAgentWorktreeIds(s, tabsByWorktree, agentStatusNow)
  )

  return useMemo(() => {
    // Board status ordering differs, but workspace visibility must use the sidebar’s filters.
    const sortedIds = allWorktrees.map((worktree) => worktree.id)
    const defaultHostId = getSettingsFocusedExecutionHostId(settings)
    return new Set(
      computeVisibleWorktrees(worktreesByRepo, sortedIds, {
        filterRepoIds,
        showSleepingWorkspaces,
        tabsByWorktree,
        ptyIdsByTabId,
        browserTabsByWorktree,
        worktreeIdsWithLiveAgent,
        worktreeIdsWithStructuredChat,
        hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces,
        hideCliCreatedWorkspaces,
        hideDetachedHeadWorkspaces,
        hideWorkspacesFromOtherDevices,
        pairedDeviceIdsByEnvironment: hideWorkspacesFromOtherDevices
          ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
          : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
        alwaysShowDefaultBranchWorkspace,
        repoMap,
        hiddenRepoRows: indexHiddenRepoRows(repos, defaultHostId),
        workspaceHostScope,
        visibleWorkspaceHostIds,
        defaultHostId,
        worktreeLineageById: {},
        // The board has no nested lineage; ancestor injection would reveal filtered-out parents as cards.
        injectLineageAncestors: false
      }).map(getWorktreeHostIdentity)
    )
  }, [
    allWorktrees,
    browserTabsByWorktree,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    settings,
    ptyIdsByTabId,
    repoMap,
    repos,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    showSleepingWorkspaces,
    tabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat,
    worktreesByRepo
  ])
}
