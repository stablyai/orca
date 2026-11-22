// The root turn one send opened, proven by the send's own id, so a reader can take that turn's answer
// and never a neighbour's. The Chat's grouping guesses where ids are missing; this never does.
import { agentJournalSubmissionKey } from './agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session/journal/agent-session-journal-producer'
import { isQueuedAgentJournalSubmission } from './agent-session/requests/agent-session-queued-submission'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session/lifecycle/records/agent-session-turn-record'
import { classifyDispatchRejection } from './agent-session/requests/structured-agent-session-dispatch-rejection'

export type StructuredAgentSessionSendTurn =
  /** No submission carries it: its card still waits in the queue, or left it. */
  | { kind: 'unsent' }
  /** Its card was edited before it went, so the turn answers another prompt. */
  | { kind: 'edited' }
  /** Handed over; no turn is proven its own yet. */
  | { kind: 'pending' }
  /** The turn it opened, which no other send went into or could have. */
  | { kind: 'turn'; itemId: string; turn: AgentJournalTurnLifecycle }
  /** Another send went, or may have gone, into the turn that answered it: their answers can't be told
   *  apart. `turn` is that turn when its row is known. */
  | { kind: 'shared'; turn?: { itemId: string; turn: AgentJournalTurnLifecycle } }
  /** The agent refused it before any turn: the request failed. */
  | { kind: 'refused' }
  /** It will never have a turn of its own: taken back, or its host stopped before the provider answered. */
  | { kind: 'none' }

/** A queued send is found by the handoff that carried its card, which has an id of its own; the
 *  handoff must carry the body that was sent. */
export function structuredAgentSessionSendTurn(
  journal: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  send: { clientMessageId: string; fingerprint: string }
): StructuredAgentSessionSendTurn {
  const { clientMessageId } = send
  const submission =
    journal.submissions.find((entry) => entry.clientMessageId === clientMessageId) ??
    journal.submissions.findLast((entry) => entry.queuedMessageId === clientMessageId)
  if (!submission) {
    return { kind: 'unsent' }
  }
  if (
    submission.queuedMessageId === clientMessageId &&
    submission.payloadFingerprint !== send.fingerprint
  ) {
    return { kind: 'edited' }
  }
  const opener = agentJournalSubmissionKey(submission.clientMessageId)
  const sent = journal.items.findIndex((item) => item.itemId === opener)
  // Where the host planned to send it, written before the provider answers; never proof it went there.
  const planned = journal.items[sent]?.turnScope
  // Before the rejection: a send a Stop took back before its echo still opened its turn.
  const opened = openedTurn(journal, submission, planned?.kind !== 'turn')
  if (opened) {
    return soleInput(journal, submission, opened.index)
      ? { kind: 'turn', itemId: opened.itemId, turn: opened.turn }
      : { kind: 'shared', turn: { itemId: opened.itemId, turn: opened.turn } }
  }
  switch (submission.dispatchState) {
    case 'rejected':
      if (classifyDispatchRejection(submission).verdict === 'failure') {
        return { kind: 'refused' }
      }
      // A Stop takes a card's handoff back and the card waits again.
      return submission.queuedMessageId === clientMessageId ? { kind: 'unsent' } : { kind: 'none' }
    case 'accepted':
      // Answered, yet no ended turn after it names it: it went into a turn another send opened.
      // The provider's record of the turn it steered into; the planned scope is never proof of it.
      if (submission.answeredInTurn?.via === 'steer') {
        return { kind: 'shared', ...steeredInto(journal, submission.answeredInTurn.turnItemId) }
      }
      return planned?.kind === 'turn' ||
        journal.items.some((item, index) => {
          const turn = index > sent ? rootTurn(item) : null
          return turn !== null && turn.state !== 'running'
        })
        ? { kind: 'shared' }
        : { kind: 'pending' }
    case 'unknown':
      // Recovered: its writer is gone, so no provider answer will come.
      return submission.recovered ? { kind: 'none' } : { kind: 'pending' }
    case 'pending':
      return { kind: 'pending' }
  }
}

/** Whether every other send provably stayed out of this turn: refused or taken back, steered into
 *  another turn, sent after it opened with none running, settled before the turn ahead of it, or the
 *  opener of a turn of its own. A provider may fold sends unanswered at its start into one turn and
 *  name only one of them, and an earlier one echoed late takes the turn over. */
function soleInput(
  journal: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  submission: AgentJournalSubmission,
  turnIndex: number
): boolean {
  const { items } = journal
  const turnItemId = items[turnIndex]?.itemId
  const previousTurn = items.findLastIndex((item, index) => index < turnIndex && rootTurn(item))
  const rows = new Map(items.map((item, index) => [item.itemId, index]))
  return journal.submissions.every((other) => {
    if (
      other.clientMessageId === submission.clientMessageId ||
      isQueuedAgentJournalSubmission(other)
    ) {
      return true
    }
    if (other.answeredInTurn?.turnItemId === turnItemId) {
      return false
    }
    if (other.dispatchState === 'rejected') {
      return true
    }
    const at = rows.get(agentJournalSubmissionKey(other.clientMessageId))
    const scope = at === undefined ? undefined : items[at]?.turnScope
    if (scope?.kind === 'turn') {
      return scope.turnItemId !== turnItemId
    }
    const settled =
      other.dispatchState === 'accepted' ||
      (other.dispatchState === 'unknown' && other.recovered === true)
    // A settled send whose row a rewind removed went before this turn.
    if ((at ?? -1) > turnIndex || (settled && (at === undefined || at < previousTurn))) {
      return true
    }
    const own = openedTurn(journal, other, true)
    return own !== null && own.itemId !== turnItemId
  })
}

/** The turn whose record names this send: by its own key, the provider's id for it when no earlier
 *  send carries that id and it wasn't sent into a running turn (a steer shares its turn's), or the
 *  host's record that a Stop took it back after it started the turn. */
function openedTurn(
  journal: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  submission: AgentJournalSubmission,
  byProviderId: boolean
): { itemId: string; index: number; turn: AgentJournalTurnLifecycle } | null {
  const { providerItemId, answeredInTurn } = submission
  const opener = agentJournalSubmissionKey(submission.clientMessageId)
  const alias =
    byProviderId &&
    providerItemId !== null &&
    journal.submissions.find((entry) => entry.providerItemId === providerItemId)
      ?.clientMessageId === submission.clientMessageId
      ? providerItemId
      : null
  const started = answeredInTurn?.via === 'start' ? answeredInTurn.turnItemId : null
  for (const [index, item] of journal.items.entries()) {
    const turn = rootTurn(item)
    if (
      turn &&
      (turn.userItemId === opener ||
        (alias !== null && turn.userItemId === alias) ||
        item.itemId === started)
    ) {
      return { itemId: item.itemId, index, turn }
    }
  }
  return null
}

function steeredInto(
  journal: Pick<AgentJournalSnapshot, 'items'>,
  itemId: string
): { turn?: { itemId: string; turn: AgentJournalTurnLifecycle } } {
  const item = journal.items.find((entry) => entry.itemId === itemId)
  const turn = item ? rootTurn(item) : null
  return turn ? { turn: { itemId, turn } } : {}
}

function rootTurn(item: AgentJournalRenderItem): AgentJournalTurnLifecycle | null {
  return (isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)) || null
}
