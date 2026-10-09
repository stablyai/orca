export type TerminalTabMoveRequest = {
  requestId: string
  tabId: string
  destWorktreeId: string
}

export type TerminalTabMoveResponse = {
  requestId: string
  error?: string
}
