import { useMemo } from 'react'
import { getWorktreeExecutionHostId } from '../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from '@/components/sidebar/visible-worktrees'
import { isDefaultBranchWorkspace } from '@/components/sidebar/default-branch-workspace'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment,
  isWorkspaceFromOtherDevice
} from '@/components/sidebar/workspace-creator-visibility'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'

type Input = Pick<
  WorktreeJumpPaletteStoreState,
  | 'allWorktrees'
  | 'hideDefaultBranchWorkspace'
  | 'hideAutomationGeneratedWorkspaces'
  | 'hideCliCreatedWorkspaces'
  | 'hideDetachedHeadWorkspaces'
  | 'hideWorkspacesFromOtherDevices'
  | 'showSleepingWorkspaces'
  | 'hideSleepingProjectKeys'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'browserTabsByWorktree'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
> &
  Pick<WorktreeJumpPaletteFilter, 'filterPredicate' | 'repoMap'> & {
    worktreeIdsWithLiveAgent: ReadonlySet<string>
  }

export function useWorktreeJumpPaletteVisibleWorktrees({
  allWorktrees,
  hideDefaultBranchWorkspace,
  hideAutomationGeneratedWorkspaces,
  hideCliCreatedWorkspaces,
  hideDetachedHeadWorkspaces,
  hideWorkspacesFromOtherDevices,
  showSleepingWorkspaces,
  hideSleepingProjectKeys,
  alwaysShowDefaultBranchWorkspace,
  tabsByWorktree,
  ptyIdsByTabId,
  browserTabsByWorktree,
  runtimeEnvironments,
  runtimeStatusByEnvironmentId,
  filterPredicate,
  repoMap,
  worktreeIdsWithLiveAgent
}: Input) {
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )
  const hiddenProjects = useMemo(() => new Set(hideSleepingProjectKeys), [hideSleepingProjectKeys])
  const emptyQueryVisibleWorktrees = useMemo(
    () =>
      allWorktrees.filter((worktree) => {
        if (worktree.isArchived) {
          return false
        }
        if (filterPredicate && !filterPredicate.matchesWorktree(worktree)) {
          return false
        }
        if (hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
          return false
        }
        if (hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
          return false
        }
        if (hideCliCreatedWorkspaces && isCliCreatedWorkspace(worktree)) {
          return false
        }
        if (hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
          return false
        }
        if (
          hideWorkspacesFromOtherDevices &&
          isWorkspaceFromOtherDevice(worktree, pairedDeviceIdsByEnvironment)
        ) {
          return false
        }
        if (
          (!showSleepingWorkspaces ||
            hiddenProjects.has(
              getRepoHostIdentityForParts(
                worktree.repoId,
                getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId))
              )
            )) &&
          !isSleepingSweepExemptWorkspace(worktree, alwaysShowDefaultBranchWorkspace) &&
          isInactiveWorkspace(
            worktree.id,
            tabsByWorktree,
            ptyIdsByTabId,
            browserTabsByWorktree,
            worktreeIdsWithLiveAgent
          )
        ) {
          return false
        }
        return true
      }),
    [
      allWorktrees,
      hiddenProjects,
      repoMap,
      alwaysShowDefaultBranchWorkspace,
      browserTabsByWorktree,
      filterPredicate,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDefaultBranchWorkspace,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      ptyIdsByTabId,
      showSleepingWorkspaces,
      tabsByWorktree,
      worktreeIdsWithLiveAgent
    ]
  )
  return emptyQueryVisibleWorktrees
}
