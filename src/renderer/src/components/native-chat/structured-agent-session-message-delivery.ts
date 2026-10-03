// Tells a composer when the host has a message it sent for good, so the chat's saved draft can stop
// holding it: the agent accepted it, or the host queued it as a card (both kept across quit and
// restart), by the send's reply or the journal (`structuredAgentSessionHostHoldsMessage`).
// A message withdrawn back into the box, or dropped, also settles; one refused, rejected or still
// unconfirmed keeps its draft copy until it is delivered or leaves. A refusal that gives the entry
// a new id is followed to that id.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

type Watched = { queuedAt: number; body: string; renamed?: (from: string, to: string) => void }
type Watcher = { messages: Map<string, Watched>; settle: () => void }

const watchersBySession = new Map<string, Set<Watcher>>()

function forEachWatcher(sessionId: string, visit: (watcher: Watcher) => void): void {
  const watchers = watchersBySession.get(sessionId)
  if (!watchers) {
    return
  }
  for (const watcher of Array.from(watchers)) {
    visit(watcher)
    if (watcher.messages.size === 0) {
      watchers.delete(watcher)
      watcher.settle()
    }
  }
  if (watchers.size === 0) {
    watchersBySession.delete(sessionId)
  }
}

/**
 * Whether the host holds a submission past quit and restart: only once the agent accepted it. A
 * pending one can still be lost: not handed over yet, the host rejects it when Orca quits or after
 * a crash; handed over but not in the agent's history, a reopen settles it as never delivered.
 */
export function structuredAgentSessionSubmissionHeldForGood(
  submission: Pick<AgentJournalSubmission, 'dispatchState'>
): boolean {
  return submission.dispatchState === 'accepted'
}

/** What the host holds for a chat, as its journal or a send's reply shows it. */
export type StructuredAgentSessionHostCopies = {
  submissions: readonly Pick<
    AgentJournalSubmission,
    'clientMessageId' | 'dispatchState' | 'queuedMessageId'
  >[]
  cards: readonly { messageId: string; state: string }[]
}

// A card the host keeps (its `queued_messages` row); a withdrawn one went back to its sender.
const HELD_CARD_STATES: ReadonlySet<string> = new Set(['waiting', 'returned', 'dispatched'])

/**
 * Whether the host holds message `clientMessageId` for good: the agent accepted it, the host keeps
 * it as a card, or a submission handed that card off. The one rule for releasing a sent message's
 * saved copy, in the session and after a relaunch; the planned relaxation switches only this.
 */
export function structuredAgentSessionHostHoldsMessage(
  host: StructuredAgentSessionHostCopies,
  clientMessageId: string
): boolean {
  return (
    host.submissions.some(
      (submission) =>
        submission.queuedMessageId === clientMessageId ||
        (submission.clientMessageId === clientMessageId &&
          structuredAgentSessionSubmissionHeldForGood(submission))
    ) ||
    host.cards.some(
      (card) => card.messageId === clientMessageId && HELD_CARD_STATES.has(card.state)
    )
  )
}

/**
 * Settles once the host has every one of `entries` (or each was withdrawn or dropped). `renamed`
 * hears when a refusal gives an entry a new id, which is then watched instead.
 */
export function whenStructuredAgentSessionHostHasMessages(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  renamed?: (from: string, to: string) => void
): Promise<void> {
  if (entries.length === 0) {
    return Promise.resolve()
  }
  return new Promise((settle) => {
    const messages = new Map(
      entries.map((entry): [string, Watched] => [
        entry.clientMessageId,
        { queuedAt: entry.queuedAt, body: JSON.stringify(entry.body), renamed }
      ])
    )
    const watchers = watchersBySession.get(sessionId) ?? new Set()
    watchersBySession.set(sessionId, watchers)
    watchers.add({ messages, settle })
  })
}

/** The host's reply to these sends shows it holds them. */
export function noteStructuredAgentSessionMessagesDelivered(
  sessionId: string,
  clientMessageIds: Iterable<string>
): void {
  const delivered = new Set(clientMessageIds)
  forEachWatcher(sessionId, (watcher) => {
    for (const id of delivered) {
      watcher.messages.delete(id)
    }
  })
}

/** A message left the outbox undelivered: its draft copy is the only one, so nothing saves over it. */
export function keepStructuredAgentSessionMessageDraft(
  sessionId: string,
  clientMessageId: string
): void {
  const watchers = watchersBySession.get(sessionId)
  for (const watcher of Array.from(watchers ?? [])) {
    if (watcher.messages.has(clientMessageId)) {
      watchers?.delete(watcher)
    }
  }
}

/** Every outbox write: a watched entry that left settles, unless it only took a new id. */
export function observeStructuredAgentSessionOutboxWrite(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): void {
  const present = new Set(entries.map((entry) => entry.clientMessageId))
  forEachWatcher(sessionId, (watcher) => {
    for (const [id, watched] of Array.from(watcher.messages)) {
      if (present.has(id)) {
        continue
      }
      watcher.messages.delete(id)
      const renamed = entries.find(
        (entry) =>
          !watcher.messages.has(entry.clientMessageId) &&
          entry.queuedAt === watched.queuedAt &&
          JSON.stringify(entry.body) === watched.body
      )
      if (renamed) {
        watcher.messages.set(renamed.clientMessageId, watched)
        watched.renamed?.(id, renamed.clientMessageId)
      }
    }
  })
}
