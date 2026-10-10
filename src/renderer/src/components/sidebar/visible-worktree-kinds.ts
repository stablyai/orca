import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

/**
 * Predicates for what KIND of workspace a row is.
 *
 * Split out of visible-worktrees so the filter/visibility logic there stays under
 * the line cap; these answer "what is this workspace", not "should it be shown".
 */

export function isSleepingSweepExemptWorkspace(
  worktree: Worktree,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return alwaysShowDefaultBranchWorkspace !== false && worktree.isMainWorktree
}

/**
 * Whether turning the exemption off is currently narrowing the list. It only
 * bites during the "Hide sleeping" sweep, so its row — and the filter badge on
 * both menu surfaces — ignores it while sleeping workspaces are shown.
 */
export function isSleepingSweepExemptionNarrowingList(
  showSleepingWorkspaces: boolean,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return !showSleepingWorkspaces && alwaysShowDefaultBranchWorkspace === false
}

export function isAutomationGeneratedWorkspace(worktree: Worktree): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(worktree: Worktree): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

/**
 * Whether a worktree sits on a detached HEAD (a commit, not a branch).
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an
 * empty branch and an empty head, so branch-emptiness alone would sweep them
 * into this filter. Requiring a real head keeps the predicate to genuine
 * detached-HEAD checkouts, matching what DetachedHeadBadge renders on the card.
 */
export function isDetachedHeadWorkspace(worktree: Worktree): boolean {
  return getWorktreeGitIdentityDisplay(worktree)?.kind === 'detached'
}

/** Inputs describing sidebar filter settings that the Clear Filters path owns. */
export type SidebarFilterState = {
  showSleepingWorkspaces: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep; absent means on. */
  alwaysShowDefaultBranchWorkspace?: boolean
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No workspaces found" message with no in-sidebar recovery path.
 */
