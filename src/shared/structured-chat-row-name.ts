/** A native chat's shown name: the user's tab alias, then the host's saved name, then the host's
 *  own label for the row. Every surface that names a native chat uses this one order. */
export function structuredChatDisplayName(
  customLabel: string | null | undefined,
  conversationName: string | null | undefined,
  fallback: string
): string {
  return customLabel?.trim() || conversationName || fallback.trim()
}
