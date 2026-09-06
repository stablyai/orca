export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
  localPtyTeardownOwnedExternally?: boolean
  force?: boolean
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}
