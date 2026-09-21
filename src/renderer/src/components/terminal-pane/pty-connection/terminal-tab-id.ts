type TerminalTabLookup = {
  getTab?: (tabId: string) => { contentType: string; entityId: string } | null
  hasTerminalTab?: (tabId: string) => boolean
}

/** Resolve a renderer tab id to the legacy terminal-tab id used by PTY state. */
export function resolveTerminalTabId(state: TerminalTabLookup, tabId: string): string {
  // The terminal-tab table is authoritative when both id forms are briefly present.
  // A stale unified entry must not redirect a live PTY owner to an older entity id.
  if (state.hasTerminalTab?.(tabId)) {
    return tabId
  }
  const unifiedTab = state.getTab?.(tabId)
  return unifiedTab?.contentType === 'terminal' ? unifiedTab.entityId : tabId
}
