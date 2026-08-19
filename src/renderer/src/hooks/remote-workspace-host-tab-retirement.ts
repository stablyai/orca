import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTerminalTabInWorkspaceSession } from '../../../shared/workspace-session-terminal-tab-close'

/**
 * Removes tabs whose publisher retracted them (see selectHostRetiredTabIdsByWorktree) from a merged
 * session.
 *
 * Runs AFTER the merge, never inside it: the merge's preserve rule stays the fallback for every tab
 * with no acknowledgement, and only a retired id is subtracted from its result.
 *
 * Reuses the shared close primitive so the whole tab model goes — terminal row, unified tab, group
 * membership, group layout, layouts, remote session id, sleeping agents, active surface. Pruning
 * `tabsByWorktree` alone would leave an unpaintable row in the tab bar that
 * projectWorktreeTabModelReconciliation then re-adopts.
 *
 * Pinned tabs survive: the primitive refuses to close them (workspace-session-terminal-tab-close
 * .ts:161-163) and this path does not override that. A pin is the local user's explicit "do not take
 * this away from me", and retirement is the one close gesture the local user did not ask for, so the
 * pin wins. The cost is that the resurrection loop stays open for pinned tabs — they are preserved
 * and re-uploaded exactly as before this change, which is today's behaviour rather than a regression.
 */
export type HostTabRetirementObserver = {
  /**
   * Fires once per tab the primitive REALLY removed, so the caller can run the same renderer-side
   * sweep a local close runs. A pinned refusal and an id this session never held are both skipped:
   * sweeping either would drop agent status for a tab that is still on screen.
   */
  onTabRetired?: (tabId: string, worktreeId: string) => void
}

export function retireHostClosedTabsFromSession(
  session: WorkspaceSessionState,
  retiredTabIdsByWorktreeId: ReadonlyMap<string, ReadonlySet<string>>,
  observer?: HostTabRetirementObserver
): WorkspaceSessionState {
  if (retiredTabIdsByWorktreeId.size === 0) {
    return session
  }
  let next = session
  for (const [worktreeId, tabIds] of retiredTabIdsByWorktreeId) {
    for (const tabId of tabIds) {
      // Why ptyIdsToKill is discarded: the client that closed the tab already killed the pty, and if
      // that kill failed the process is one another client may have rebound. Retirement removes a
      // tab from this client's model; it never kills anything on the host.
      const closeResult = closeTerminalTabInWorkspaceSession(next, worktreeId, tabId)
      next = closeResult.session
      if (closeResult.closed) {
        observer?.onTabRetired?.(tabId, worktreeId)
      }
    }
  }
  // Why the workspace identity is restored: closing the last surface of the active worktree clears
  // these three so a user-initiated close lands on the home screen. A peer's close is not a
  // navigation the local user asked for, and the worktree they are standing in still exists.
  if (session.activeWorktreeId != null && next.activeWorktreeId == null) {
    next = {
      ...next,
      activeWorktreeId: session.activeWorktreeId,
      activeWorkspaceKey: session.activeWorkspaceKey,
      activeWorkspaceExecutionHostId: session.activeWorkspaceExecutionHostId
    }
  }
  return next
}
