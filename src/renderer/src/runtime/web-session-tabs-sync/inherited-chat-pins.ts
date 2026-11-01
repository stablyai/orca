/**
 * A switched chat takes its pin from the tab it replaced on this client, and keeps it while the
 * host's flag still says what it said when this client adopted the chat. Once the host's flag
 * changes (someone pinned or unpinned it there), the chat follows the host as any chat does.
 * Renderer memory only: an entry dies with that change or when its chat leaves the snapshot.
 */
const hostPinAtAdoption = new Map<string, boolean>()

const keyOf = (scope: string, sessionId: string) => `${scope}\0${sessionId}`

export function adoptInheritedChatPin(scope: string, sessionId: string, hostPinned: boolean): void {
  hostPinAtAdoption.set(keyOf(scope, sessionId), hostPinned)
}

/** Whether this client's inherited pin still stands against the host's flag on this frame. */
export function inheritedChatPinHolds(
  scope: string,
  sessionId: string,
  hostPinned: boolean | undefined
): boolean {
  const key = keyOf(scope, sessionId)
  const adopted = hostPinAtAdoption.get(key)
  if (adopted === undefined) {
    return false
  }
  if (hostPinned !== undefined && hostPinned !== adopted) {
    hostPinAtAdoption.delete(key)
    return false
  }
  return true
}

/** Drops entries of this scope whose chats the snapshot no longer lists. */
export function pruneInheritedChatPins(scope: string, listed: ReadonlySet<string>): void {
  if (hostPinAtAdoption.size === 0) {
    return
  }
  const prefix = `${scope}\0`
  for (const key of hostPinAtAdoption.keys()) {
    if (key.startsWith(prefix) && !listed.has(key.slice(prefix.length))) {
      hostPinAtAdoption.delete(key)
    }
  }
}

export function resetInheritedChatPinsForTests(): void {
  hostPinAtAdoption.clear()
}
