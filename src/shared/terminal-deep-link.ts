// Matches only what the runtime mints: `term_` + randomUUID, or `term_` + 32 hex digest chars.
const TERMINAL_DEEP_LINK_PATTERN =
  /^orca:\/\/terminal\/(term_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}))\/?$/

// Why a raw-string match: URL parsing would resolve `..` segments before they could be rejected.
export function parseTerminalDeepLink(value: string): string | null {
  return TERMINAL_DEEP_LINK_PATTERN.exec(value)?.[1] ?? null
}

export function terminalHandleFromArguments(argv: readonly string[]): string | null {
  for (const value of argv) {
    const handle = parseTerminalDeepLink(value)
    if (handle) {
      return handle
    }
  }
  return null
}
