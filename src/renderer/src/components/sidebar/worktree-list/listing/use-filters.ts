import { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  clearSidebarFilters,
  selectSidebarFilterState,
  sidebarHasActiveFilters,
  sidebarWorkspaceRowFilters
} from '../controls/sidebar-filter-actions'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  activeWorkspaceRowFilterKeys,
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
import { createSleepingSweepHiddenCheck } from './sleeping-sweep-visibility'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'

export type SidebarWorktreeFilters = ReturnType<typeof useSidebarWorktreeFilters>

type RevealContext = {
  state: AppState
  worktree: Worktree
  repo: Repo | undefined
  targetHostId: ExecutionHostId
}

/** Require every shared filter key to provide a reveal action so new filters cannot omit recovery. */
const REVEAL_WORKSPACE: Record<keyof WorkspaceRowFilters, (context: RevealContext) => void> = {
  filterRepoIds: ({ state, worktree, targetHostId }) => {
    const folderScope = parseWorkspaceKey(worktree.id)
    if (folderScope?.type === 'folder') {
      // Two hosts can hold folders with the same id; resolve it against the row's own host.
      const folderResult = resolveQualifiedIndexedFolderWorkspace(
        state,
        folderScope.folderWorkspaceId,
        targetHostId
      )
      if (folderResult.kind !== 'selected') {
        return
      }
      const folder = folderResult.value.workspace
      const groupRepos = state.repos.filter(
        (repo) => repo.projectGroupId === folder.projectGroupId
      )
      // A selected repo of the group already passes this filter; another filter hides the folder.
      if (groupRepos.some((repo) => state.filterRepoIds.includes(repo.id))) {
        return
      }
      // The filter stores repository ids; reveal the folder through a repo of its project group.
      const [groupRepo] = groupRepos
      if (groupRepo) {
        state.setFilterRepoIds([...state.filterRepoIds, groupRepo.id])
      } else if (state.filterRepoIds.length > 0) {
        // A group with no repo cannot be selected; clearing removes the only filter hiding it.
        state.setFilterRepoIds([])
      }
      return
    }
    if (!state.filterRepoIds.includes(worktree.repoId)) {
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
    if (createSleepingSweepHiddenCheck(state)(worktree)) {
      state.setShowSleepingWorkspaces(true)
    }
  },
  // Turning the exemption off only narrows; "Hide sleeping" above is what reveals.
  alwaysShowDefaultBranchWorkspace: () => {}
}

function getRevealTargetHostId(
  state: AppState,
  worktree: Worktree,
  repo: Repo | undefined,
  executionHostId?: ExecutionHostId
) {
  // The sidebar row's own host wins; same-id folders on other hosts must not steer the reveal.
  if (executionHostId) {
    return executionHostId
  }
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const workspaceScope = parseWorkspaceKey(worktree.id)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = selectFolderWorkspaces(state).find(
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

export function useSidebarWorktreeFilters() {
  const filterState = useAppStore(useShallow(selectSidebarFilterState))

  const revealWorkspaceFilters = useCallback(
    (worktree: Worktree, executionHostId?: ExecutionHostId) => {
      const state = useAppStore.getState()
      const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
      const context = {
        state,
        worktree,
        repo,
        targetHostId: getRevealTargetHostId(state, worktree, repo, executionHostId)
      }
      for (const key of activeWorkspaceRowFilterKeys(sidebarWorkspaceRowFilters(state))) {
        REVEAL_WORKSPACE[key](context)
      }
    },
    []
  )

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
