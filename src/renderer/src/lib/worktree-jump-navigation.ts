import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { getVisibleWorktreeShortcutTargets } from '@/components/sidebar/visible-worktrees'
import { worktreePassesSidebarFilters } from '@/components/sidebar/worktree-filter-visibility'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

function wasHiddenBySidebarFilters(worktreeId: string, executionHostId?: ExecutionHostId): boolean {
  const state = useAppStore.getState()
  // Some lightweight callers/tests provide only the activation slice of state.
  if (!state.worktreesByRepo || !sidebarHasActiveFilters(state)) {
    return false
  }

  const inRenderedTargets = getVisibleWorktreeShortcutTargets().some((target) => {
    if (target.id !== worktreeId) {
      return false
    }
    if (!executionHostId) {
      return true
    }
    // Why strict: legacy rows publish without a host, and a hostless twin must not vouch for a
    // filtered ssh:*/runtime:* target — that would clear the user's filters instead of warning.
    if (!target.executionHostId) {
      return false
    }
    return (
      normalizeExecutionHostId(target.executionHostId) === normalizeExecutionHostId(executionHostId)
    )
  })
  if (inRenderedTargets) {
    return false
  }
  // Why: a retained agent can outlive its worktree; a deleted worktree fails every filter
  // pass, so without this check any active filter would blame itself for the missing row.
  if (!state.getKnownWorktreeById?.(worktreeId, executionHostId)) {
    return false
  }
  // Absent from the rendered list can mean a collapsed group, not a filter:
  // collapsed-but-unfiltered targets should be revealed, not toasted. The host
  // matters: an id-only check would pass on a filtered target's same-id twin
  // from another execution host.
  return !worktreePassesSidebarFilters(worktreeId, executionHostId)
}

/** Navigate from a worktree reference in either sidebar back to the workspace surface. */
export function jumpToWorktreeFromSidebar(
  worktreeId: string,
  options?: { executionHostId?: ExecutionHostId }
): boolean {
  const state = useAppStore.getState()

  // Folder workspaces aren't in the worktree filter pipeline; only git worktrees can be filter-hidden.
  const hiddenBeforeActivation =
    parseWorkspaceKey(worktreeId)?.type !== 'folder' &&
    wasHiddenBySidebarFilters(worktreeId, options?.executionHostId)

  // Why the workspace dispatcher: it owns the folder-vs-worktree split and the folder path-status gate.
  const activated = activateAndRevealWorkspace(worktreeId, {
    ...(hiddenBeforeActivation ? { revealInSidebar: false, clearSidebarFilters: false } : {}),
    ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {})
  })
  if (activated === false) {
    return false
  }

  // The worktree list is the Spaces/Projects sidebar body; jump actions should always expose it.
  state.setSidebarBody?.('workspaces')

  const hiddenAfterActivation =
    hiddenBeforeActivation && wasHiddenBySidebarFilters(worktreeId, options?.executionHostId)
  if (hiddenBeforeActivation && !hiddenAfterActivation) {
    // Activation can seed a terminal, making a workspace excluded only by Hide sleeping visible.
    // Queue the reveal after that state transition instead of reporting a filter conflict.
    useAppStore
      .getState()
      .revealWorktreeInSidebar(
        worktreeId,
        options?.executionHostId ? { executionHostId: options.executionHostId } : {}
      )
  }

  if (hiddenAfterActivation) {
    toast.warning(
      translate(
        'auto.lib.worktreeJumpNavigation.filteredNotice',
        'This worktree is hidden by sidebar filters. The workspace was opened, but it is not shown in Spaces.'
      )
    )
  }
  return true
}
