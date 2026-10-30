// Replay proven-unreceived ordinary message text (never images) at the next human turn, at most once. A carrier's carries covers it unless refused before provider delivery; derive from the host journal each handover.

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

/** Exclude commands/goals/agent mail and slash commands whose wording only works at the prompt start. */
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

// Only words-only pre-write refusal proves zero bytes reached the agent; other kinds may follow provider writes.
const REFUSED_BEFORE_WRITE: ReadonlySet<SubmissionRejectionKind> = new Set([
  'queueFull',
  'writeFailed'
])

/** Refused before anything reached the agent: what it carried is owed again. */
function refusedBeforeWrite(carrier: AgentJournalSubmission): boolean {
  if (carrier.dispatchState !== 'rejected' || carrier.answeredInTurn) {
    return false
  }
  // Accept explicit unwritten proof from Stop, pre-write child exit or Pi sign-in checks.
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

/** Owe stopped messages in send order; exclude ones too large to fit beside a one-letter send so they cannot block others. */
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

/** Deliver newest owed text then older text while total fits MAX_PROMPT_BYTES; if newest cannot fit, all remain owed. Cover even omitted messages so none arrives after newer ones. */
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

/** Carry history only on words-only sends; unread attachment size could exceed agent limits. */
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
