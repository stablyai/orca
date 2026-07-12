export type TerminalSearchMatch = {
  paneId: number
  worktreeId: string
  tabId: string
  title: string
  lineNumber: number
  lineText: string
  matchStartIndex: number
  matchEndIndex: number
}

export type TerminalPaneRegistration = {
  paneId: number
  worktreeId: string
  tabId: string
  getTitle: () => string
  getBufferLines: () => string[]
  focus: () => void
}

const registry = new Map<number, TerminalPaneRegistration>()

export function registerTerminalPane(paneId: number, registration: TerminalPaneRegistration): void {
  registry.set(paneId, registration)
}

export function unregisterTerminalPane(paneId: number): void {
  registry.delete(paneId)
}

export function getTerminalPaneRegistration(paneId: number): TerminalPaneRegistration | undefined {
  return registry.get(paneId)
}

export function searchAllTerminals(
  query: string,
  caseSensitive: boolean = false
): TerminalSearchMatch[] {
  if (!query) {
    return []
  }
  const results: TerminalSearchMatch[] = []
  const lowerQuery = caseSensitive ? query : query.toLowerCase()

  for (const reg of registry.values()) {
    const lines = reg.getBufferLines()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) {
        continue
      }

      const searchTarget = caseSensitive ? line : line.toLowerCase()
      let startIndex = searchTarget.indexOf(lowerQuery)

      while (startIndex !== -1) {
        results.push({
          paneId: reg.paneId,
          worktreeId: reg.worktreeId,
          tabId: reg.tabId,
          title: reg.getTitle(),
          lineNumber: i,
          lineText: line,
          matchStartIndex: startIndex,
          matchEndIndex: startIndex + query.length
        })
        startIndex = searchTarget.indexOf(lowerQuery, startIndex + query.length)
      }
    }
  }

  return results
}
