/** Share name precedence across surfaces: user alias, host-saved name, host row label. */
export function structuredChatDisplayName(
  customLabel: string | null | undefined,
  conversationName: string | null | undefined,
  fallback: string
): string {
  return customLabel?.trim() || conversationName || fallback.trim()
}

/** Only Claude/Codex history uses chat names; other agents retain CLI conversation titles. */
export function historyRowShowsChatName(rowAgent: string): boolean {
  return rowAgent === 'claude' || rowAgent === 'codex'
}
