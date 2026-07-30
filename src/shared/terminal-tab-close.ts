export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}
