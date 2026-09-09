import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { computeVisibleWorktrees } from './visible-worktrees'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from './workspace-creator-visibility'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

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
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
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
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  // Why: skip the clock entirely when the epoch is the opt-out sentinel, so a
  // sleeping-workspaces board cannot evict the sample the live boards share.
  const agentStatusNow = showSleepingWorkspaces ? 0 : getAgentStatusEpochNow(agentStatusEpoch)
  // Why snapshot on the epoch: the always-mounted drawer must not scan every
  // agent on unrelated store writes; membership changes advance this tick. Keep
  // the epoch itself in the deps — two bumps in one millisecond share a sample,
  // so `agentStatusNow` alone would not re-key the memo.
  const worktreeIdsWithLiveAgent = useMemo(() => {
    void agentStatusEpoch
    return !showSleepingWorkspaces
      ? getWorktreeIdsWithLiveAgent(
          useAppStore.getState().agentStatusByPaneKey,
          tabsByWorktree,
          agentStatusNow
        )
      : EMPTY_WORKTREE_ID_SET
  }, [agentStatusEpoch, agentStatusNow, showSleepingWorkspaces, tabsByWorktree])

  return useMemo(() => {
    // Why: the board has its own status ordering, but visibility must match
    // the sidebar filters exactly so hidden workspaces do not reappear here.
    const sortedIds = allWorktrees.map((worktree) => worktree.id)
    return new Set(
      computeVisibleWorktrees(worktreesByRepo, sortedIds, {
        filterRepoIds,
        showSleepingWorkspaces,
        tabsByWorktree,
        ptyIdsByTabId,
        browserTabsByWorktree,
        worktreeIdsWithLiveAgent,
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
        workspaceHostScope,
        visibleWorkspaceHostIds,
        defaultHostId: getSettingsFocusedExecutionHostId(settings),
        worktreeLineageById: {},
        // Why: the board has no nested lineage presentation. Ancestor injection
        // would make filtered-out parents appear as ordinary cards.
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
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    showSleepingWorkspaces,
    tabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreesByRepo
  ])
}
