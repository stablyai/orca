/** Share name precedence across surfaces: user alias, host-saved name, host row label. */
export function structuredChatDisplayName(
  customLabel: string | null | undefined,
  conversationName: string | null | undefined,
  fallback: string
): string {
  return customLabel?.trim() || conversationName || fallback.trim()
}

/** Unnamed Claude/Codex rows use chat labels; other unnamed agents retain provider titles. */
export function historyRowFallsBackToChatLabel(rowAgent: string): boolean {
  return rowAgent === 'claude' || rowAgent === 'codex'
}
