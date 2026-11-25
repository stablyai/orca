// Before Orca closes a session tab on its own (not a person), the window, which owns the layout, says
// whether someone is using it or lately used it, from its current store in one synchronous read. On
// consent it closes nothing; it remembers consenting, so the removal itself can be decided again.
import type { AppState } from '../../../store/types'
import type { SessionTabAutomaticClose } from '../../../../../shared/workspace-layout/client-views/session-tab-close'
import { recordAutomaticCloseConsent } from '../../../runtime/web-session-tabs-sync/closing/automatic-close-consents'

/** Kept: in front of any of its workspace's groups, pinned, or focused or opened since `since`. A tab
 *  this window can't find is kept too: its mapping may be incomplete. */
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
    return true
  }
  const inFront = (state.groupsByWorktree?.[worktreeId] ?? []).some(
    (group) => group.activeTabId === tab.id
  )
  return (
    inFront || tab.isPinned === true || (tab.lastFocusedAt ?? 0) >= since || tab.createdAt >= since
  )
}

/** The window's answer; on consent, the consent is remembered for the removal. */
export function answerAutomaticSessionTabClose(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>,
  worktreeId: string,
  tabId: string,
  automatic: SessionTabAutomaticClose,
  now: number = Date.now()
): 'kept' | 'consent' {
  if (automaticSessionTabCloseKept(state, worktreeId, tabId, automatic)) {
    return 'kept'
  }
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
  if (tab) {
    recordAutomaticCloseConsent(worktreeId, tab.entityId, now)
  }
  return 'consent'
}
