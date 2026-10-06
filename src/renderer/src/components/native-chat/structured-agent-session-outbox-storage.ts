import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionAttachment,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  settleStructuredAgentSessionOutboxEntryWatches,
  type StructuredAgentSessionOutboxEntryRemoval
} from './structured-agent-session-outbox-entry-watch'

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

/** Whether any entry still owes a delivery: a copy the host recorded and rejected owes none. */
function owesDelivery(entries: readonly StructuredAgentSessionOutboxEntry[]): boolean {
  return entries.some((entry) => !structuredAgentSessionEntryRejectedByHost(entry))
}

/** Keep the journal subscription alive while this session still owes delivery. */
export function hasUndeliveredStructuredAgentSessionOutbox(sessionId: string): boolean {
  return undeliveredSessions.get(sessionId)?.undelivered ?? owesDelivery(readOutbox(sessionId))
}

export function subscribeToUndeliveredStructuredAgentSessionOutbox(
  sessionId: string,
  listener: () => void
): () => void {
  let subscription = undeliveredSessions.get(sessionId)
  if (!subscription) {
    subscription = { undelivered: owesDelivery(readOutbox(sessionId)), listeners: new Set() }
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
    publishUndelivered(sessionId, owesDelivery(entries))
    return true
  } catch {
    return false
  }
}

type HeldOutbox = {
  entries: StructuredAgentSessionOutboxEntry[]
  listeners: Set<() => void>
}

// Why: while a chat is open its outbox lives here, not in the view, so every writer — the
// composer, a launch settlement, a message sent from elsewhere — changes the one copy it shows.
const heldOutboxes = new Map<string, HeldOutbox>()

/** The session's outbox: the held copy while a chat has it open, otherwise storage as written. */
export function getStructuredAgentSessionOutbox(
  sessionId: string
): StructuredAgentSessionOutboxEntry[] {
  return (
    heldOutboxes.get(sessionId)?.entries ?? readOutbox(sessionId, { recoverDispatching: false })
  )
}

function holdOutbox(
  sessionId: string,
  load: () => StructuredAgentSessionOutboxEntry[]
): HeldOutbox {
  let held = heldOutboxes.get(sessionId)
  if (!held) {
    held = { entries: load(), listeners: new Set() }
    heldOutboxes.set(sessionId, held)
  }
  return held
}

/** Loads the session's outbox for a chat that is opening it; `load` runs once per hold. */
export function loadStructuredAgentSessionOutbox(
  sessionId: string,
  load: () => StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxEntry[] {
  return holdOutbox(sessionId, load).entries
}

/** Holds the session's outbox in memory until the last subscriber leaves. */
export function subscribeToStructuredAgentSessionOutbox(
  sessionId: string,
  load: () => StructuredAgentSessionOutboxEntry[],
  listener: () => void
): () => void {
  const held = holdOutbox(sessionId, load)
  held.listeners.add(listener)
  return () => {
    held.listeners.delete(listener)
    if (held.listeners.size === 0 && heldOutboxes.get(sessionId) === held) {
      heldOutboxes.delete(sessionId)
    }
  }
}

/** Makes `entries` the session's outbox and saves it. With `onlyIfSaved`, a failed save leaves
 *  the outbox as it was; otherwise the open chat still shows the change. */
export function commitStructuredAgentSessionOutbox(
  sessionId: string,
  entries: StructuredAgentSessionOutboxEntry[],
  options: { onlyIfSaved?: boolean } = {}
): boolean {
  return commitOutbox(sessionId, entries, options, 'spent')
}

function commitOutbox(
  sessionId: string,
  entries: StructuredAgentSessionOutboxEntry[],
  options: { onlyIfSaved?: boolean },
  removal: StructuredAgentSessionOutboxEntryRemoval
): boolean {
  const saved = writeOutbox(sessionId, entries)
  if (!saved && options.onlyIfSaved) {
    return false
  }
  const held = heldOutboxes.get(sessionId)
  if (held && held.entries !== entries) {
    held.entries = entries
    for (const listener of held.listeners) {
      listener()
    }
  }
  settleStructuredAgentSessionOutboxEntryWatches(sessionId, entries, removal)
  return saved
}

/** Queues a user message on the session's outbox: the one enqueue the composer, a launch prompt,
 *  and a message sent from outside the chat all share. */
export function appendStructuredAgentSessionOutboxMessage(
  sessionId: string,
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[] = [],
  source?: 'launch'
): StructuredAgentSessionOutboxEntry | null {
  const entry = {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: createStructuredAgentSessionOperationId(createBrowserUuid),
      sessionId,
      text,
      attachments,
      queuedAt: Date.now()
    }),
    ...(source ? { source } : {})
  }
  return commitStructuredAgentSessionOutbox(
    sessionId,
    [...getStructuredAgentSessionOutbox(sessionId), entry],
    { onlyIfSaved: true }
  )
    ? entry
    : null
}

export function enqueueStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  text: string
): StructuredAgentSessionOutboxEntry | null {
  return appendStructuredAgentSessionOutboxMessage(sessionId, text, [], 'launch')
}

export function discardStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  commitOutbox(sessionId, [], {}, 'discarded')
}

export function mutateStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  clientMessageId: string,
  update: StructuredAgentSessionLaunchPromptMutation,
  options: { onlyIfSaved?: boolean } = {}
): boolean {
  let matched = false
  const next = getStructuredAgentSessionOutbox(sessionId).flatMap((entry) => {
    if (entry.clientMessageId !== clientMessageId) {
      return [entry]
    }
    matched = true
    // The settlement reads its own in-flight send as storage recovery would: unconfirmed.
    const replacement = update(
      entry.state === 'dispatching' ? { ...entry, state: 'unconfirmed' } : entry
    )
    return replacement ? [replacement] : []
  })
  return matched && commitStructuredAgentSessionOutbox(sessionId, next, options)
}

export type StructuredAgentSessionLaunchPromptMutation = (
  entry: StructuredAgentSessionOutboxEntry
) => StructuredAgentSessionOutboxEntry | null
