export const SESSION_TAB_CLOSE_CANCELED_ERROR = 'session_tab_close_canceled'
export const SESSION_TAB_CLOSE_FAILED_ERROR = 'session_tab_close_failed'
export const SESSION_TAB_NOT_FOUND_ERROR = 'session_tab_not_found'
export const SESSION_TAB_CLOSE_TIMEOUT_ERROR = 'session_tab_close_timeout'

export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
  expiresAt?: number
}

export type SessionTabCloseResponse = {
  requestId: string
  error?: string
}
