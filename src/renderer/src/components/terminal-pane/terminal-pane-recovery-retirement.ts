type TerminalPaneRecoveryRetirementHandler = (tabId: string) => void

let retirementHandler: TerminalPaneRecoveryRetirementHandler | null = null

export function registerTerminalPaneRecoveryRetirementHandler(
  handler: TerminalPaneRecoveryRetirementHandler
): () => void {
  retirementHandler = handler
  return () => {
    if (retirementHandler === handler) {
      retirementHandler = null
    }
  }
}

export function forgetRetiredTerminalPaneRecovery(tabId: string): void {
  retirementHandler?.(tabId)
}
