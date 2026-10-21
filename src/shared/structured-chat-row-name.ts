/** A native chat's shown name: the user's tab alias, then the host's saved name, then the host's
 *  own label for the row. Every surface that names a native chat uses this one order. */
export function structuredChatDisplayName(
  customLabel: string | null | undefined,
  conversationName: string | null | undefined,
  fallback: string
): string {
  return customLabel?.trim() || conversationName || fallback.trim()
}

/** Whether a Session History row a native chat owns shows the chat's name. Only Claude and Codex
 *  rows do; other agents' rows keep their CLI's own title, as their terminal conversations do. */
export function historyRowShowsChatName(rowAgent: string): boolean {
  return rowAgent === 'claude' || rowAgent === 'codex'
}
