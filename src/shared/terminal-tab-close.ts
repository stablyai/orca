// Why: the outer runtime RPC must outlive renderer durability adjudication;
// otherwise a valid close can look failed locally before the host commits it.
export const TERMINAL_TAB_CLOSE_RENDERER_TIMEOUT_MS = 20_000
export const TERMINAL_TAB_CLOSE_RUNTIME_RPC_TIMEOUT_MS = 30_000

export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
  validateOnly?: boolean
  expectedPtyIds?: string[]
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}
