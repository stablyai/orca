import { useMemo } from 'react'
import { getStructuredChatWorktreeIds } from '@/components/sidebar/worktree-list/listing/visible-worktree-activity-inputs'
import { buildDesktopWorkspaceRowFactReader } from '@/components/sidebar/worktree-list/listing/desktop-workspace-row-facts'
import { getLiveAgentStatusByWorktreeId } from '@/lib/workspace/activity/worktree-activity-state'
import { partitionWorkspaceRowsByFilters } from '../../../../../shared/workspace-view/workspace-row-filters'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../../shared/workspace-view/workspace-creator-visibility'
import type { HiddenProjects } from '../../../../../shared/project/catalog/hidden-projects'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeJumpPaletteWorktreesInput } from './worktree-jump-palette-worktrees-input'

type PaletteRowFilterInput = Pick<
  WorktreeJumpPaletteWorktreesInput,
  | 'workspaces'
  | 'filterPredicate'
  | 'agentStatusByPaneKey'
  | 'tabsByWorktree'
  | 'hideDefaultBranchWorkspace'
  | 'hideAutomationGeneratedWorkspaces'
  | 'hideCliCreatedWorkspaces'
  | 'hideDetachedHeadWorkspaces'
  | 'hideWorkspacesFromOtherDevices'
  | 'showSleepingWorkspaces'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'ptyIdsByTabId'
  | 'browserTabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'structuredChatSleptAtByPaneKey'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'repoMap'
  | 'defaultHostId'
> & { hiddenProjects: HiddenProjects }

export type PaletteRowFilterView = {
  /** What the empty query lists: the rows the sidebar's workspace filters keep. */
  emptyQueryVisibleWorktrees: Worktree[]
  /** Host identities of matches the filters hide; search still lists them, tagged Hidden. */
  filterHiddenIdentities: ReadonlySet<string>
}

export function useWorktreeJumpPaletteRowFilters(
  input: PaletteRowFilterInput
): PaletteRowFilterView {
  const {
    workspaces,
    filterPredicate,
    agentStatusByPaneKey,
    tabsByWorktree,
    hideWorkspacesFromOtherDevices,
    showSleepingWorkspaces,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    hiddenProjects
  } = input
  const worktreeIdsWithLiveAgent = useMemo(
    () =>
      new Set(
        // The palette recomputes this snapshot when status inputs change; the
        // clock intentionally reflects the render that performs that snapshot.
        // oxlint-disable-next-line react/purity
        getLiveAgentStatusByWorktreeId(agentStatusByPaneKey, tabsByWorktree, Date.now()).keys()
      ),
    [agentStatusByPaneKey, tabsByWorktree]
  )
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )
  const worktreeIdsWithStructuredChat = getStructuredChatWorktreeIds(
    showSleepingWorkspaces,
    input.unifiedTabsByWorktree,
    input.structuredChatSleptAtByPaneKey
  )
  return useMemo(() => {
    // Why no project or host scope: the palette ignores the sidebar's scope; filterPredicate scopes it.
    const { visible, hiddenByFilters } = partitionWorkspaceRowsByFilters(
      workspaces,
      {
        hideSleepingWorkspaces: !showSleepingWorkspaces,
        alwaysShowDefaultBranchWorkspace: input.alwaysShowDefaultBranchWorkspace,
        hideDefaultBranchWorkspace: input.hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces: input.hideAutomationGeneratedWorkspaces,
        hideCliCreatedWorkspaces: input.hideCliCreatedWorkspaces,
        hideDetachedHeadWorkspaces: input.hideDetachedHeadWorkspaces,
        hideWorkspacesFromOtherDevices,
        filterRepoIds: [],
        visibleHostIds: null
      },
      buildDesktopWorkspaceRowFactReader({
        repoMap: input.repoMap,
        hiddenProjects,
        defaultHostId: input.defaultHostId,
        pairedDeviceIdsByEnvironment,
        tabsByWorktree,
        ptyIdsByTabId: input.ptyIdsByTabId,
        browserTabsByWorktree: input.browserTabsByWorktree,
        worktreeIdsWithLiveAgent,
        worktreeIdsWithStructuredChat
      })
    )
    return {
      emptyQueryVisibleWorktrees: filterPredicate
        ? visible.filter(filterPredicate.matchesWorktree)
        : visible,
      filterHiddenIdentities: new Set(hiddenByFilters.map(getWorktreeHostIdentity))
    }
  }, [
    workspaces,
    input.alwaysShowDefaultBranchWorkspace,
    input.browserTabsByWorktree,
    filterPredicate,
    input.hideAutomationGeneratedWorkspaces,
    input.hideCliCreatedWorkspaces,
    input.hideDefaultBranchWorkspace,
    input.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    pairedDeviceIdsByEnvironment,
    input.ptyIdsByTabId,
    input.repoMap,
    hiddenProjects,
    input.defaultHostId,
    showSleepingWorkspaces,
    tabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  ])
}
