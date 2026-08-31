import {
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'

function storageKey(sessionId: string): string {
  return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

export function readOutbox(sessionId: string): StructuredAgentSessionOutboxEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? '[]')
    return Array.isArray(value)
      ? value
          .map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
          .filter((entry): entry is StructuredAgentSessionOutboxEntry => entry !== null)
          .map((entry) =>
            entry.state === 'dispatching' ? { ...entry, state: 'unconfirmed' as const } : entry
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
    return true
  } catch {
    return false
  }
}
