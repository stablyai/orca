export type TerminalTabCloseExpectation = {
  terminalHandle: string
  ptyId: string
  leafId: string
  incarnationId?: string
}

export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
  localPtyTeardownOwnedExternally?: boolean
  expectedTerminal?: TerminalTabCloseExpectation
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}
