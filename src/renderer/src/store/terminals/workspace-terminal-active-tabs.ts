import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** Restore per-worktree active tab; validate ids when the map exists, else derive for legacy sessions. */
export function restoreActiveTabIdByWorktree({
  session,
  validWorktreeIds,
  validTabIds,
  canonicalTabIdBySubsumedTabId,
  tabsByWorktree,
  activeWorktreeId,
  activeTabId
}: {
  session: Pick<WorkspaceSessionState, 'activeTabIdByWorktree'>
  validWorktreeIds: ReadonlySet<string>
  validTabIds: ReadonlySet<string>
  canonicalTabIdBySubsumedTabId: ReadonlyMap<string, string>
  tabsByWorktree: Readonly<Record<string, TerminalTab[]>>
  /** The restored active workspace and terminal, already validated. */
  activeWorktreeId: string | null
  activeTabId: string | null
}): Record<string, string | null> {
  const activeTabIdByWorktree: Record<string, string | null> = {}
  if (session.activeTabIdByWorktree) {
    for (const [wId, tabId] of Object.entries(session.activeTabIdByWorktree)) {
      if (!validWorktreeIds.has(wId) || !tabId) {
        continue
      }
      // Why: a subsumed row's canonical twin holds the same PTY, so follow the pointer there
      // instead of forgetting which terminal the workspace last focused.
      const restored = validTabIds.has(tabId) ? tabId : canonicalTabIdBySubsumedTabId.get(tabId)
      if (restored && validTabIds.has(restored)) {
        activeTabIdByWorktree[wId] = restored
      }
    }
  } else {
    // Legacy sessions: best-effort derivation
    if (activeWorktreeId && activeTabId) {
      activeTabIdByWorktree[activeWorktreeId] = activeTabId
    }
    for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
      if (!activeTabIdByWorktree[wId] && tabs.length > 0) {
        activeTabIdByWorktree[wId] = tabs[0].id
      }
    }
  }
  return activeTabIdByWorktree
}
