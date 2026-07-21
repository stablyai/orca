export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}

export type SessionTabCloseResult = 'closed' | 'already-absent'

export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
}

export type SessionTabCloseResponse = {
  requestId: string
  result?: SessionTabCloseResult
  error?: string
}
