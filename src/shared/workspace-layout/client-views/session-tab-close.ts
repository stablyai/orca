export const SESSION_TAB_CLOSE_CANCELED_ERROR = 'session_tab_close_canceled'
export const SESSION_TAB_CLOSE_FAILED_ERROR = 'session_tab_close_failed'
export const SESSION_TAB_NOT_FOUND_ERROR = 'session_tab_not_found'
export const SESSION_TAB_CLOSE_TIMEOUT_ERROR = 'session_tab_close_timeout'
/** An automatic close the window turned down because a person is using, or lately used, the tab. */
export const SESSION_TAB_CLOSE_KEPT_ERROR = 'session_tab_close_kept'

/** Orca asking, before a close it makes on its own, whether the window may lose the tab: answered
 *  `session_tab_close_kept` if the tab is in front of its group, pinned, or was focused or opened at or
 *  after `keptIfTouchedSince`; never asks a person and never closes the tab itself (the host's hide
 *  removes it from the window's snapshot). */
export type SessionTabAutomaticClose = { keptIfTouchedSince: number }

export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
  expiresAt?: number
  automatic?: SessionTabAutomaticClose
}

export type SessionTabCloseResponse = {
  requestId: string
  error?: string
}
