export const SESSION_TAB_CLOSE_CANCELED_ERROR = 'session_tab_close_canceled'
export const SESSION_TAB_CLOSE_FAILED_ERROR = 'session_tab_close_failed'
export const SESSION_TAB_NOT_FOUND_ERROR = 'session_tab_not_found'
export const SESSION_TAB_CLOSE_TIMEOUT_ERROR = 'session_tab_close_timeout'

/** A chat tab whose host close main runs leaves only once that close lands: `confirm` asks the
 *  window and keeps the tab, then `drop` removes it or `failed` keeps it and shows `error`. */
export type SessionTabCloseStage = 'confirm' | 'drop' | 'failed'

export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
  expiresAt?: number
  stage?: SessionTabCloseStage
  error?: string
}

export type SessionTabCloseResponse = {
  requestId: string
  error?: string
}
