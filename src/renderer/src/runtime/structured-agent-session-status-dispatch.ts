// Keyed change dispatch for one host status feed: a session's update wakes only that session's readers.

/** The sessions an update touched; null when any session's facts may have changed (contact, Sleep or naming state for the whole host). */
export type StructuredAgentSessionStatusChange = ReadonlySet<string> | null

export function createStructuredAgentSessionStatusDispatch(): {
  emit: (sessionIds: Iterable<string> | null) => void
  subscribe: (listener: (change: StructuredAgentSessionStatusChange) => void) => () => void
  subscribeSession: (sessionId: string, listener: () => void) => () => void
} {
  const listeners = new Set<(change: StructuredAgentSessionStatusChange) => void>()
  const sessionListeners = new Map<string, Set<() => void>>()
  return {
    emit: (sessionIds) => {
      const change = sessionIds === null ? null : new Set(sessionIds)
      // Listeners may unsubscribe others mid-dispatch; collect first, then skip any already removed.
      const keyed: [Set<() => void>, () => void][] = []
      for (const registered of change === null
        ? sessionListeners.values()
        : Array.from(
            change,
            (sessionId) => sessionListeners.get(sessionId) ?? new Set<() => void>()
          )) {
        for (const listener of registered) {
          keyed.push([registered, listener])
        }
      }
      for (const listener of Array.from(listeners)) {
        if (listeners.has(listener)) {
          listener(change)
        }
      }
      for (const [registered, listener] of keyed) {
        if (registered.has(listener)) {
          listener()
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeSession: (sessionId, listener) => {
      let registered = sessionListeners.get(sessionId)
      if (!registered) {
        registered = new Set()
        sessionListeners.set(sessionId, registered)
      }
      registered.add(listener)
      const owned = registered
      return () => {
        owned.delete(listener)
        // Drop empty buckets so readers of chats without tabs leave nothing behind.
        if (owned.size === 0 && sessionListeners.get(sessionId) === owned) {
          sessionListeners.delete(sessionId)
        }
      }
    }
  }
}

/** Ids that entered or left a set; null when there was no previous answer, so every id's answer changed. */
export function membershipChanges(
  previous: ReadonlySet<string> | null,
  next: ReadonlySet<string>
): string[] | null {
  if (previous === null) {
    return null
  }
  return [
    ...Array.from(next).filter((id) => !previous.has(id)),
    ...Array.from(previous).filter((id) => !next.has(id))
  ]
}
