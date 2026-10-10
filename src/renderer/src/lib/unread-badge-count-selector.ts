import { getVisibleWorkspaceHostIdSet } from '@/components/sidebar/visible-worktree-host-scope'
import { getPairedDeviceIdsByEnvironment } from '@/components/sidebar/workspace-creator-visibility'
import { getRepoMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { sameBucketRecords } from './bucket-record-equality'
import { getUnreadBadgeCount, hasUnreadFolderTab } from './unread-badge-count'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

type UnreadBadgeCountState = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'workspaceHostScope'
  | 'visibleWorkspaceHostIds'
  | 'hideWorkspacesFromOtherDevices'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
>

/** The worktree fields the count reads (`id` embeds `repoId`), so equality over them is a sound cache key. */
function sameBadgeWorktree(previous: Worktree, next: Worktree): boolean {
  const previousCreator = previous.creatorProvenance
  const nextCreator = next.creatorProvenance
  return (
    previous.runtimeOwnerEnvironmentId === next.runtimeOwnerEnvironmentId &&
    previousCreator?.kind === nextCreator?.kind &&
    (previousCreator?.kind !== 'paired-device' ||
      (nextCreator?.kind === 'paired-device' &&
        previousCreator.deviceId === nextCreator.deviceId)) &&
    previous.id === next.id &&
    previous.hostId === next.hostId &&
    previous.isUnread === next.isUnread &&
    previous.isArchived === next.isArchived
  )
}

function sameFolderAttention(
  previous: UnreadBadgeCountState,
  next: UnreadBadgeCountState
): boolean {
  if (
    previous.tabsByWorktree === next.tabsByWorktree &&
    previous.unifiedTabsByWorktree === next.unifiedTabsByWorktree &&
    previous.unreadTerminalTabs === next.unreadTerminalTabs
  ) {
    return true
  }
  for (const folder of next.folderWorkspaces) {
    if (!folder.isUnread) {
      continue
    }
    const key = folderWorkspaceKey(folder.id)
    if (hasUnreadFolderTab(previous, key) !== hasUnreadFolderTab(next, key)) {
      return false
    }
  }
  return true
}

function sameCountInputs(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  return (
    previous.folderWorkspaces === next.folderWorkspaces &&
    previous.projectGroups === next.projectGroups &&
    previous.repos === next.repos &&
    previous.workspaceHostScope === next.workspaceHostScope &&
    previous.visibleWorkspaceHostIds === next.visibleWorkspaceHostIds &&
    previous.settings?.activeRuntimeEnvironmentId === next.settings?.activeRuntimeEnvironmentId &&
    previous.hideWorkspacesFromOtherDevices === next.hideWorkspacesFromOtherDevices &&
    // Why gated: runtime status reallocates on remote activity and only this filter reads it.
    (!next.hideWorkspacesFromOtherDevices ||
      (previous.runtimeEnvironments === next.runtimeEnvironments &&
        previous.runtimeStatusByEnvironmentId === next.runtimeStatusByEnvironmentId)) &&
    sameBucketRecords(previous.worktreesByRepo, next.worktreesByRepo, sameBadgeWorktree) &&
    sameFolderAttention(previous, next)
  )
}

/**
 * Why: the App root holds this subscription for a single integer. Returning the raw maps re-rendered
 * the whole shell on every agent title frame; selecting the count instead means the subscription
 * only notifies when the badge value can actually have moved.
 *
 * Why chaining against the immediately preceding state is enough: equality over the count's read
 * set is transitive, so a run of unchanged states is equivalent to comparing against the state
 * that produced the cached count.
 */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeCountState) => number {
  let previousState: UnreadBadgeCountState | undefined
  let unreadCount = 0

  return (state) => {
    if (!previousState || !sameCountInputs(previousState, state)) {
      unreadCount = getUnreadBadgeCount({
        worktreesByRepo: state.worktreesByRepo,
        folderWorkspaces: state.folderWorkspaces,
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: state.unifiedTabsByWorktree,
        unreadTerminalTabs: state.unreadTerminalTabs,
        projectGroups: state.projectGroups,
        repoMap: getRepoMapFromState(state),
        visibleHostIds: getVisibleWorkspaceHostIdSet(state),
        defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
        hiddenOtherDevicePairings: state.hideWorkspacesFromOtherDevices
          ? getPairedDeviceIdsByEnvironment(
              state.runtimeEnvironments,
              state.runtimeStatusByEnvironmentId
            )
          : null
      })
    }
    previousState = state
    return unreadCount
  }
}
