import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from '@/components/sidebar/visible-worktrees'
import { isDefaultBranchWorkspace } from '@/components/sidebar/default-branch-workspace'
import {
  collectAgentTypesByWorktree,
  worktreeMatchesAgentFilter
} from '@/components/sidebar/workspace-agent-filter-evidence'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { isWorkspaceFromOtherDevice } from '@/components/sidebar/workspace-creator-visibility'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'

type EmptyQueryVisibilityArgs = Pick<
  WorktreeJumpPaletteStoreState,
  | 'allWorktrees'
  | 'hideDefaultBranchWorkspace'
  | 'hideAutomationGeneratedWorkspaces'
  | 'hideCliCreatedWorkspaces'
  | 'hideDetachedHeadWorkspaces'
  | 'hideWorkspacesFromOtherDevices'
  | 'showSleepingWorkspaces'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'filterAgentIds'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'browserTabsByWorktree'
> &
  Pick<WorktreeJumpPaletteFilter, 'filterPredicate'> & {
    pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
    worktreeIdsWithLiveAgent: ReadonlySet<string>
  }

// Why extracted: the palette hook is already at the line cap; Agent filter
// must stay on this same empty-query pass as the sidebar.
export function filterEmptyQueryVisibleWorktrees(args: EmptyQueryVisibilityArgs): Worktree[] {
  const agentTypesByWorktree = args.filterAgentIds
    ? collectAgentTypesByWorktree({
        agentStatusByPaneKey: args.agentStatusByPaneKey,
        retainedAgentsByPaneKey: args.retainedAgentsByPaneKey,
        sleepingAgentSessionsByPaneKey: args.sleepingAgentSessionsByPaneKey,
        tabsByWorktree: args.tabsByWorktree
      })
    : null
  return args.allWorktrees.filter((worktree) => {
    if (worktree.isArchived) {
      return false
    }
    if (args.filterPredicate && !args.filterPredicate.matchesWorktree(worktree)) {
      return false
    }
    if (args.hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
      return false
    }
    if (args.hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
      return false
    }
    if (args.hideCliCreatedWorkspaces && isCliCreatedWorkspace(worktree)) {
      return false
    }
    if (args.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
      return false
    }
    if (
      args.hideWorkspacesFromOtherDevices &&
      isWorkspaceFromOtherDevice(worktree, args.pairedDeviceIdsByEnvironment)
    ) {
      return false
    }
    if (
      !args.showSleepingWorkspaces &&
      !isSleepingSweepExemptWorkspace(worktree, args.alwaysShowDefaultBranchWorkspace) &&
      isInactiveWorkspace(
        worktree.id,
        args.tabsByWorktree,
        args.ptyIdsByTabId,
        args.browserTabsByWorktree,
        args.worktreeIdsWithLiveAgent
      )
    ) {
      return false
    }
    return worktreeMatchesAgentFilter(worktree, args.filterAgentIds, {
      tabsByWorktree: args.tabsByWorktree,
      agentTypesByWorktree
    })
  })
}
