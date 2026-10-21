// Ordinary messages Orca proves the agent never received, owed to it at most once: derived from the
// journal on each handover (host only), and carried at the front of the person's next send that
// opens a turn, for every agent. One is covered by a carrier's `carries` unless that carrier was
// refused before anything reached the agent. Words only: a stopped message's images are not replayed.

import { readAgentSessionFailureFact, type SubmissionRejectionKind } from './agent-session-failure'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  classifyDispatchRejection,
  dispatchWasWithdrawn
} from './structured-agent-session-dispatch-rejection'
import { MAX_PROMPT_BYTES } from './rpc-contract/structured-agent-session-message-params'

/** The record Claude writes for its own Stop, carried after each stopped message. */
export const STOPPED_MESSAGE_INTERRUPTED_MARKER = '[Request interrupted by user]'

export type StoppedHistoryJournal = {
  submissions: readonly AgentJournalSubmission[]
  /** Each handed-over send's carried history, by its client message id. */
  carried: ReadonlyMap<string, readonly string[]>
  /** The latest /clear's sequence; 0 when none. */
  clearSequence: number
  body: (clientMessageId: string) => AgentJournalItemBody | null
}

export type OwedStoppedMessage = {
  clientMessageId: string
  words: string
}

/** A person's ordinary message: not a command, a goal, mail another agent sent, or a typed slash
 *  command, which only reads right as the start of a prompt. */
function isOrdinaryPersonMessage(
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  if (
    body?.kind !== 'message' ||
    body.role !== 'user' ||
    body.command !== undefined ||
    body.sentAs !== undefined ||
    body.from !== undefined
  ) {
    return false
  }
  const firstText = body.blocks.find((block) => block.type === 'text' && block.text.length > 0)
  return !(firstText?.type === 'text' && firstText.text.startsWith('/'))
}

/** A Stop took it back where Orca proves the agent never received it. */
function withdrawnUnwritten(submission: AgentJournalSubmission): boolean {
  return (
    dispatchWasWithdrawn(submission) &&
    !submission.answeredInTurn &&
    readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true
  )
}

// Raised by Orca before any byte of a words-only send reached the agent; any other kind may follow
// a provider write.
const REFUSED_BEFORE_WRITE: ReadonlySet<SubmissionRejectionKind> = new Set([
  'queueFull',
  'writeFailed'
])

/** Refused before anything reached the agent: what it carried is owed again. */
function refusedBeforeWrite(carrier: AgentJournalSubmission): boolean {
  if (carrier.dispatchState !== 'rejected' || carrier.answeredInTurn) {
    return false
  }
  // Proven unwritten where it was refused: a Stop's withdrawal, a child gone before the write, or a
  // sign-in Pi checks before recording the prompt.
  if (readAgentSessionFailureFact(carrier.rejection)?.neverReachedAgent === true) {
    return true
  }
  const { kind } = classifyDispatchRejection(carrier)
  return kind !== undefined && REFUSED_BEFORE_WRITE.has(kind)
}

const encoder = new TextEncoder()

/** Words as a send's size limit counts them. */
function wordsBytes(words: string): number {
  return encoder.encode(JSON.stringify(words)).length
}

/** Per message, the framing `withStoppedHistory` writes beyond its words. */
export const STOPPED_MESSAGE_FRAMING_BYTES = wordsBytes(
  `\n\n${STOPPED_MESSAGE_INTERRUPTED_MARKER}\n\n`
)

/** What a stopped message takes of the send it rides with. */
function deliveryBytes(words: string): number {
  return wordsBytes(words) + STOPPED_MESSAGE_FRAMING_BYTES
}

/** The stopped messages owed to the agent, in the order they were sent. One too large to deliver
 *  beside even a one-letter send is not owed, so it never holds the others back. */
export function agentSessionStoppedHistoryOwed(
  journal: StoppedHistoryJournal
): OwedStoppedMessage[] {
  const byId = new Map(journal.submissions.map((entry) => [entry.clientMessageId, entry]))
  const covered = new Set<string>()
  for (const [carrierId, carried] of journal.carried) {
    const carrier = byId.get(carrierId)
    if (carrier && !refusedBeforeWrite(carrier)) {
      carried.forEach((id) => covered.add(id))
    }
  }
  return journal.submissions
    .flatMap((submission) => {
      if (
        submission.acceptedSequence === undefined ||
        submission.acceptedSequence <= journal.clearSequence ||
        submission.origin !== 'client' ||
        submission.source?.kind !== 'user' ||
        submission.queuedMessageId !== undefined ||
        covered.has(submission.clientMessageId) ||
        !withdrawnUnwritten(submission)
      ) {
        return []
      }
      const { clientMessageId, acceptedSequence } = submission
      const body = journal.body(clientMessageId)
      const words = isOrdinaryPersonMessage(body) ? messageWords(body) : ''
      return words.length > 0 && deliveryBytes(words) + wordsBytes('x') <= MAX_PROMPT_BYTES
        ? [{ clientMessageId, words, acceptedSequence }]
        : []
    })
    .sort((left, right) => left.acceptedSequence - right.acceptedSequence)
    .map(({ clientMessageId, words }) => ({ clientMessageId, words }))
}

/** A message's words as an agent joins its text blocks. */
function messageWords(body: AgentJournalMessageItem): string {
  return body.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
}

/** One delivery: the newest owed message, and older ones while they fit, in the order sent. With
 *  the send's own words they never exceed what one send can hold (`MAX_PROMPT_BYTES`), so the agent
 *  is handed nothing larger than a send the person could make; if the newest doesn't fit, all stay
 *  owed. It covers every owed message, those left out included, so none arrives after a newer one. */
export type StoppedHistoryDelivery = {
  messages: OwedStoppedMessage[]
  covers: string[]
}

export function selectStoppedHistory(
  owed: readonly OwedStoppedMessage[],
  send: AgentJournalMessageItem
): StoppedHistoryDelivery | null {
  const messages: OwedStoppedMessage[] = []
  let room = MAX_PROMPT_BYTES - wordsBytes(messageWords(send))
  for (const entry of owed.toReversed()) {
    const cost = deliveryBytes(entry.words)
    if (cost <= room) {
      room -= cost
      messages.unshift(entry)
    } else if (messages.length === 0) {
      return null
    }
  }
  return messages.length > 0
    ? { messages, covers: owed.map((entry) => entry.clientMessageId) }
    : null
}

/** Whether this send's handover delivers the stopped messages owed: a person's ordinary message, a
 *  queued card's hand-off included. */
export function agentSessionSendDeliversStoppedHistory(
  submission: Pick<AgentJournalSubmission, 'source' | 'queuedMessageId'>,
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  // A card's hand-off records no sender; its body's missing `from` says it is the person's.
  const persons = submission.source?.kind === 'user' || submission.queuedMessageId !== undefined
  return persons && isOrdinaryPersonMessage(body)
}

/** Whether this send can carry stopped messages: words only, so the carried words can never take
 *  it past an agent's limits, which its attachments' unread size could. */
export function agentSessionSendCarriesStoppedHistory(body: AgentJournalMessageItem): boolean {
  return body.blocks.every((block) => block.type === 'text') && messageWords(body).length > 0
}

/** A words-only send's body with the delivered stopped messages ahead of its own words, each
 *  followed by the record Claude writes for its own Stop. */
export function withStoppedHistory(
  body: AgentJournalMessageItem,
  messages: readonly OwedStoppedMessage[]
): AgentJournalMessageItem {
  const carried = messages
    .map((entry) => `${entry.words}\n\n${STOPPED_MESSAGE_INTERRUPTED_MARKER}\n\n`)
    .join('')
  return { ...body, blocks: [{ type: 'text', text: `${carried}${messageWords(body)}` }] }
}
