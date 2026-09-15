import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'

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

const undeliveredSessions = new Map<string, boolean>()
const undeliveredListeners = new Set<() => void>()

function publishUndelivered(sessionId: string, undelivered: boolean): void {
  if (undeliveredSessions.get(sessionId) === undelivered) {
    return
  }
  undeliveredSessions.set(sessionId, undelivered)
  for (const listener of undeliveredListeners) {
    listener()
  }
}

/** Delivery must not wait on the pane being looked at, so the journal subscription that retires
 *  an entry is kept alive off this rather than off visibility. Every outbox mutation in the
 *  renderer passes through `writeOutbox`, so this is the one place that can publish it. */
export function hasUndeliveredStructuredAgentSessionOutbox(sessionId: string): boolean {
  const known = undeliveredSessions.get(sessionId)
  if (known !== undefined) {
    return known
  }
  const undelivered = readOutbox(sessionId).length > 0
  undeliveredSessions.set(sessionId, undelivered)
  return undelivered
}

export function subscribeToUndeliveredStructuredAgentSessionOutbox(
  listener: () => void
): () => void {
  undeliveredListeners.add(listener)
  return () => {
    undeliveredListeners.delete(listener)
  }
}

export function resetUndeliveredStructuredAgentSessionOutboxForTests(): void {
  undeliveredSessions.clear()
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
    publishUndelivered(sessionId, entries.length > 0)
    return true
  } catch {
    return false
  }
}

export function enqueueStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  text: string
): StructuredAgentSessionOutboxEntry | null {
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
    sessionId,
    text,
    attachments: [],
    queuedAt: Date.now()
  })
  return writeOutbox(sessionId, [...readOutbox(sessionId), entry]) ? entry : null
}

export function discardStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  writeOutbox(sessionId, [])
}

export function mutateStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  clientMessageId: string,
  update: StructuredAgentSessionLaunchPromptMutation
): boolean {
  const current = readOutbox(sessionId)
  let matched = false
  const next = current.flatMap((entry) => {
    if (entry.clientMessageId !== clientMessageId) {
      return [entry]
    }
    matched = true
    const replacement = update(entry)
    return replacement ? [replacement] : []
  })
  return matched && writeOutbox(sessionId, next)
}

export type StructuredAgentSessionLaunchPromptMutation = (
  entry: StructuredAgentSessionOutboxEntry
) => StructuredAgentSessionOutboxEntry | null
