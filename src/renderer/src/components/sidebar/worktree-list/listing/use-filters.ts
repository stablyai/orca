import { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  clearSidebarFilters,
  selectSidebarFilterState,
  sidebarHasActiveFilters,
  sidebarWorkspaceRowFilters
} from '../../sidebar-filter-actions'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  activeWorkspaceRowFilterKeys,
  isSleepingSweepExempt,
  type WorkspaceRowFilters
} from '../../../../../../shared/workspace-view/workspace-row-filters'
import { resolveVisibleWorkspaceHostIds } from '../../../../../../shared/workspace-view/workspace-host-visibility'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getWorktreeExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDefaultBranchWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../../shared/worktree/workspace-kinds'
import { getFolderWorkspaceExecutionHostIdForRows } from '../../../../../../shared/sidebar-list/host-filtering'
import {
  getPairedDeviceIdsByEnvironment,
  isWorkspaceOwnedBySomeoneElse
} from '../../../../../../shared/workspace-creator-visibility'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getAllWorktreesFromState } from '@/store/selectors'
import { worktreePassesSidebarFilters } from '../../worktree-filter-visibility'
import {
  collectAgentTypesByWorktree,
  collidingWorktreeIds,
  resolveRevealFilterAgentIds
} from '../../workspace-agent-filter-evidence'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getWorktreeIdsWithStructuredChat
} from '../../visible-worktree-activity-inputs'

export type SidebarWorktreeFilters = ReturnType<typeof useSidebarWorktreeFilters>

type RevealContext = {
  state: AppState
  worktree: Worktree
  repo: Repo | undefined
  targetHostId: ExecutionHostId
}

/**
 * For each active filter, how to make one workspace visible again. Keyed on the shared filter
 * keys, so a new filter fails to compile until it says how a hidden workspace is revealed.
 */
const REVEAL_WORKSPACE: Record<keyof WorkspaceRowFilters, (context: RevealContext) => void> = {
  filterRepoIds: ({ state, worktree }) => {
    if (!worktree.id.startsWith('folder:') && !state.filterRepoIds.includes(worktree.repoId)) {
      state.setFilterRepoIds([...state.filterRepoIds, worktree.repoId])
    }
  },
  visibleHostIds: ({ state, targetHostId }) => {
    const shown = resolveVisibleWorkspaceHostIds(
      state.visibleWorkspaceHostIds,
      state.workspaceHostScope
    )
    if (shown && !shown.includes(targetHostId)) {
      state.setVisibleWorkspaceHostIds([...shown, targetHostId])
    }
  },
  hideDefaultBranchWorkspace: ({ state, worktree, repo }) => {
    if (isDefaultBranchWorkspace(worktree, repo)) {
      state.setHideDefaultBranchWorkspace(false)
    }
  },
  hideAutomationGeneratedWorkspaces: ({ state, worktree }) => {
    if (isAutomationGeneratedWorkspace(worktree)) {
      state.setHideAutomationGeneratedWorkspaces(false)
    }
  },
  hideCliCreatedWorkspaces: ({ state, worktree }) => {
    if (isCliCreatedWorkspace(worktree)) {
      state.setHideCliCreatedWorkspaces(false)
    }
  },
  hideDetachedHeadWorkspaces: ({ state, worktree }) => {
    if (isDetachedHeadWorkspace(worktree)) {
      state.setHideDetachedHeadWorkspaces(false)
    }
  },
  hideWorkspacesFromOtherDevices: ({ state, worktree }) => {
    const pairedDeviceIds = getPairedDeviceIdsByEnvironment(
      state.runtimeEnvironments,
      state.runtimeStatusByEnvironmentId
    )
    if (isWorkspaceOwnedBySomeoneElse(worktree, pairedDeviceIds)) {
      state.setHideWorkspacesFromOtherDevices(false)
    }
  },
  hideSleepingWorkspaces: ({ state, worktree }) => {
    const tabsByWorktree = getVisibleWorktreeTerminalActivityTabs(state.tabsByWorktree)
    const browserTabsByWorktree = getVisibleWorktreeBrowserActivityTabs(state.browserTabsByWorktree)
    const liveAgentWorktrees = getWorktreeIdsWithLiveAgent(
      state.agentStatusByPaneKey,
      tabsByWorktree,
      getAgentStatusEpochNow(state.agentStatusEpoch)
    )
    if (
      !isSleepingSweepExempt(worktree.isMainWorktree, state.alwaysShowDefaultBranchWorkspace) &&
      isInactiveWorkspace(
        worktree.id,
        tabsByWorktree,
        state.ptyIdsByTabId,
        browserTabsByWorktree,
        liveAgentWorktrees,
        getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree)
      )
    ) {
      state.setShowSleepingWorkspaces(true)
    }
  },
  // Turning the exemption off only narrows; "Hide sleeping" above is what reveals.
  alwaysShowDefaultBranchWorkspace: () => {}
}

function getRevealTargetHostId(state: AppState, worktree: Worktree, repo: Repo | undefined) {
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const workspaceScope = parseWorkspaceKey(worktree.id)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (candidate) => candidate.id === workspaceScope.folderWorkspaceId
    )
    if (folderWorkspace) {
      return getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace,
        projectGroup: state.projectGroups.find(
          (candidate) => candidate.id === folderWorkspace.projectGroupId
        ),
        defaultHostId
      })
    }
  }
  return getWorktreeExecutionHostId(worktree, repo, defaultHostId)
}

function revealAgentFilter(context: RevealContext): void {
  const { state, worktree, targetHostId } = context
  if (!state.filterAgentIds) {
    return
  }
  const worktrees = getAllWorktreesFromState(state)
  const lookup = {
    tabsByWorktree: state.tabsByWorktree,
    agentTypesByWorktree: collectAgentTypesByWorktree({
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      tabsByWorktree: state.tabsByWorktree,
      worktrees
    }),
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    collidingWorktreeIds: collidingWorktreeIds(worktrees)
  }
  // Why: the listing, not a parallel match, decides whether Agent still hides it.
  const next = resolveRevealFilterAgentIds(
    state.filterAgentIds,
    worktree,
    lookup,
    !worktreePassesSidebarFilters(worktree.id, targetHostId)
  )
  if (next !== state.filterAgentIds) {
    state.setFilterAgentIds(next)
  }
  if (
    useAppStore.getState().filterAgentIds &&
    !worktreePassesSidebarFilters(worktree.id, targetHostId)
  ) {
    useAppStore.getState().setFilterAgentIds(null)
  }
}

// Every sidebar filter, plus the single escape hatch that resets all of them.
export function useSidebarWorktreeFilters() {
  const filterState = useAppStore(useShallow(selectSidebarFilterState))

  const revealWorkspaceFilters = useCallback((worktree: Worktree) => {
    const state = useAppStore.getState()
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    const context = {
      state,
      worktree,
      repo,
      targetHostId: getRevealTargetHostId(state, worktree, repo)
    }
    for (const key of activeWorkspaceRowFilterKeys(sidebarWorkspaceRowFilters(state))) {
      REVEAL_WORKSPACE[key](context)
    }
    revealAgentFilter(context)
  }, [])

  const clearFilters = useCallback(
    () => clearSidebarFilters(filterState, useAppStore.getState()),
    [filterState]
  )

  return {
    filterState,
    hasFilters: sidebarHasActiveFilters(filterState),
    clearFilters,
    revealWorkspaceFilters
  }
}
