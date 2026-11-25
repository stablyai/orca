// Before Orca closes a session tab on its own (not a person), the window, which owns the layout, says
// whether someone is using it or lately used it, from its current store in one synchronous read.
import type { AppState } from '../../../store/types'
import type { SessionTabAutomaticClose } from '../../../../../shared/workspace-layout/client-views/session-tab-close'

/** Kept: in front of any of its workspace's groups, pinned, or focused or opened since `since`. A tab
 *  the window doesn't have is not kept here; the caller answers not-found. */
export function automaticSessionTabCloseKept(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>,
  worktreeId: string,
  tabId: string,
  { keptIfTouchedSince: since }: SessionTabAutomaticClose
): boolean {
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
  if (!tab) {
    return false
  }
  const inFront = (state.groupsByWorktree?.[worktreeId] ?? []).some(
    (group) => group.activeTabId === tab.id
  )
  return (
    inFront || tab.isPinned === true || (tab.lastFocusedAt ?? 0) >= since || tab.createdAt >= since
  )
}
