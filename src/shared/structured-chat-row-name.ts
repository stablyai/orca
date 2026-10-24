/** A native chat's shown name: the user's tab alias, then the host's saved name, then the host's
 *  own label for the row. Every surface that names a native chat uses this one order. */
export function structuredChatDisplayName(
  customLabel: string | null | undefined,
  conversationName: string | null | undefined,
  fallback: string
): string {
  return customLabel?.trim() || conversationName || fallback.trim()
}

/** Whether a Session History row a native chat owns, and the chat has no name yet, reads the chat's
 *  default label. Claude and Codex rows do, as their tabs do; other agents' rows keep their CLI's
 *  own title until the chat is named. A named chat's row always shows its name. */
export function historyRowFallsBackToChatLabel(rowAgent: string): boolean {
  return rowAgent === 'claude' || rowAgent === 'codex'
}
