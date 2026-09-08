import {
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

const listeners = new Map<string, Set<(entries: StructuredAgentSessionOutboxEntry[]) => void>>()

export function subscribeOutbox(
  sessionId: string,
  listener: (entries: StructuredAgentSessionOutboxEntry[]) => void
): () => void {
  const group = listeners.get(sessionId) ?? new Set()
  listeners.set(sessionId, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) {
      listeners.delete(sessionId)
    }
  }
}

const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'

export function storageKey(sessionId: string): string {
  return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

export function readOutbox(
  sessionId: string,
  recoverDispatching = true
): StructuredAgentSessionOutboxEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? '[]')
    return Array.isArray(value)
      ? value
          .map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
          .filter((entry): entry is StructuredAgentSessionOutboxEntry => entry !== null)
          .map((entry) =>
            recoverDispatching && entry.state === 'dispatching'
              ? { ...entry, state: 'unconfirmed' as const }
              : entry
          )
          .sort((left, right) => left.queuedAt - right.queuedAt)
      : []
  } catch {
    return []
  }
}

export function writeOutbox(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(storageKey(sessionId))
    } else {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(entries))
    }
    for (const listener of listeners.get(sessionId) ?? []) {
      listener(entries.slice())
    }
    return true
  } catch {
    return false
  }
}
