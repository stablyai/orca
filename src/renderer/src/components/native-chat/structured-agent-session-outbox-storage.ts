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

export function readOutbox(
  sessionId: string,
  options: { recoverDispatching?: boolean } = {}
): StructuredAgentSessionOutboxEntry[] {
  const recoverDispatching = options.recoverDispatching !== false
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

type UndeliveredSessionSubscription = {
  undelivered: boolean
  listeners: Set<() => void>
}

const undeliveredSessions = new Map<string, UndeliveredSessionSubscription>()

function publishUndelivered(sessionId: string, undelivered: boolean): void {
  const subscription = undeliveredSessions.get(sessionId)
  if (!subscription || subscription.undelivered === undelivered) {
    return
  }
  subscription.undelivered = undelivered
  for (const listener of subscription.listeners) {
    listener()
  }
}

/** Keep the journal subscription alive while this session still owes delivery. */
export function hasUndeliveredStructuredAgentSessionOutbox(sessionId: string): boolean {
  return undeliveredSessions.get(sessionId)?.undelivered ?? readOutbox(sessionId).length > 0
}

export function subscribeToUndeliveredStructuredAgentSessionOutbox(
  sessionId: string,
  listener: () => void
): () => void {
  let subscription = undeliveredSessions.get(sessionId)
  if (!subscription) {
    subscription = { undelivered: readOutbox(sessionId).length > 0, listeners: new Set() }
    undeliveredSessions.set(sessionId, subscription)
  }
  const owned = subscription
  owned.listeners.add(listener)
  return () => {
    owned.listeners.delete(listener)
    if (owned.listeners.size === 0 && undeliveredSessions.get(sessionId) === owned) {
      undeliveredSessions.delete(sessionId)
    }
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
  const entry = {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
      sessionId,
      text,
      attachments: [],
      queuedAt: Date.now()
    }),
    source: 'launch' as const
  }
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
