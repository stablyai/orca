// Root turn records anchor to the user entry that opened them; a provider-resumed record anchors to itself.

import { agentJournalSubmissionKey } from '../../agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../agent-session/journal/agent-session-journal-producer'
import { isQueuedAgentJournalSubmission } from '../../agent-session/requests/agent-session-queued-submission'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../agent-session/lifecycle/agent-session-turn-record'
import { dispatchWasWithdrawn } from '../../agent-session/requests/structured-agent-session-dispatch-rejection'
import { inSendOrder } from '../native-chat-send-order'
import type { AgentSessionLatestTurn } from '../../agent-session/agent-session-wire'

/** Map root records to present user openers via direct/provider-adopted ids; older unnamed records use the nearest preceding user row.
 * Before Codex echoes an opener, use its in-flight submission or host-attributed take-back; otherwise anchor on the record.
 * A steer may echo the shared provider key first, but the earliest in-flight send opened the turn. */
export function structuredAgentTurnAnchors(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  /** Anchored too while it runs with its record above the loaded rows; nothing loaded precedes it. */
  latestTurn?: AgentSessionLatestTurn | null
): ReadonlyMap<string, string> {
  const userItemIds = new Set(
    items.flatMap((item) =>
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      item.turnScope?.kind !== 'unknown'
        ? [item.itemId]
        : []
    )
  )
  const steeredInto = new Map(
    items.flatMap((item) =>
      item.turnScope?.kind === 'turn' && userItemIds.has(item.itemId)
        ? [[item.itemId, item.turnScope.turnItemId] as const]
        : []
    )
  )
  const aliases = new Map<string, string>()
  // Codex steers reuse the running turn’s provider key; the earliest submission naming it is the opener.
  for (const submission of submissions) {
    if (submission.providerItemId && !aliases.has(submission.providerItemId)) {
      aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  // Handed over and not echoed yet; a send still queued opens nothing ahead of a turn record.
  const inFlight = new Set(
    submissions
      .filter(
        (submission) =>
          submission.dispatchState === 'pending' &&
          !submission.providerItemId &&
          !isQueuedAgentJournalSubmission(submission)
      )
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  // Stop may take back an opener before its provider echo; host answeredInTurn names the turn or explicit none. Older records fall back to journal order.
  const takenBack = submissions.filter(
    (submission) =>
      !submission.providerItemId &&
      submission.queuedMessageId === undefined &&
      submission.resolvedAt !== null &&
      dispatchWasWithdrawn(submission)
  )
  const itemsById =
    takenBack.length > 0 ? new Map(items.map((item) => [item.itemId, item])) : undefined
  const openedBy = stoppedTurnOpeners(takenBack)
  const unstated = inSendOrder(
    takenBack
      .filter((submission) => submission.answeredInTurn === undefined)
      .flatMap((submission) => {
        const sent = itemsById?.get(agentJournalSubmissionKey(submission.clientMessageId))
        return sent ? [{ sent, submission }] : []
      }),
    ({ submission }) => submission
  )
  const claimed = new Set<string>()
  const anchors = new Map<string, string>()
  let precedingUserItemId: string | null = null
  let inFlightSinceLastTurn: string | null = null
  for (const item of items) {
    if (item.turnScope?.kind === 'unknown') {
      precedingUserItemId = null
      continue
    }
    if (userItemIds.has(item.itemId)) {
      precedingUserItemId = item.itemId
      if (inFlightSinceLastTurn === null && inFlight.has(item.itemId)) {
        inFlightSinceLastTurn = item.itemId
      }
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (!turn || !isRootAgentJournalItem(item)) {
      continue
    }
    let anchor = anchorOf(
      item.itemId,
      turn,
      userItemIds,
      aliases,
      steeredInto,
      precedingUserItemId,
      inFlightSinceLastTurn
    )
    const key = turn.userItemId
    const unresolved =
      key !== undefined && !userItemIds.has(key) && !userItemIds.has(aliases.get(key) ?? '')
    // A record naming itself is a turn the provider resumed on its own: no send opened it.
    if (unresolved && key !== item.itemId) {
      const named = openedBy.get(item.itemId)
      if (named !== undefined && itemsById?.has(named)) {
        anchor = named
      } else if (anchor === item.itemId) {
        const opener = unstated.find(
          ({ sent, submission }) =>
            !claimed.has(sent.itemId) && sentBeforeAndTakenBackAfter(item, turn, submission, sent)
        )
        if (opener) {
          claimed.add(opener.sent.itemId)
          anchor = opener.sent.itemId
        }
      }
    }
    anchors.set(item.itemId, anchor)
    inFlightSinceLastTurn = null
  }
  // Only while running: an ended turn's tail would otherwise regroup when the next turn opens.
  if (latestTurn?.turn.state === 'running' && !anchors.has(latestTurn.itemId)) {
    anchors.set(
      latestTurn.itemId,
      anchorOf(latestTurn.itemId, latestTurn.turn, userItemIds, aliases, steeredInto, null, null)
    )
  }
  return anchors
}

/** Only taken-back sends with answeredInTurn.via:start open turns; steers and unknown newer modes do not. */
export function stoppedTurnOpeners(
  takenBack: readonly AgentJournalSubmission[]
): ReadonlyMap<string, string> {
  const openers = new Map<string, string>()
  for (const { answeredInTurn, clientMessageId } of takenBack) {
    if (answeredInTurn?.via === 'start' && !openers.has(answeredInTurn.turnItemId)) {
      openers.set(answeredInTurn.turnItemId, agentJournalSubmissionKey(clientMessageId))
    }
  }
  return openers
}

/** For old chats lacking turn attribution, preserve sent-sequence journal placement across take-back.
 * Temporary until a host floor: when neither field exists, use row position/times despite resume’s whole-second timestamp rewriting. */
function sentBeforeAndTakenBackAfter(
  record: AgentJournalRenderItem,
  turn: AgentJournalTurnLifecycle,
  submission: AgentJournalSubmission,
  sent: AgentJournalRenderItem
): boolean {
  if (submission.submittedSequence !== undefined) {
    return submission.submittedSequence < record.sequence && record.sequence < sent.sequence
  }
  if (turn.startedAt === undefined || submission.resolvedAt === null) {
    return false
  }
  const sentBefore = sent.sequence < record.sequence || submission.submittedAt <= turn.startedAt
  return sentBefore && turn.startedAt <= submission.resolvedAt
}

function anchorOf(
  turnItemId: string,
  turn: AgentJournalTurnLifecycle,
  userItemIds: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
  steeredInto: ReadonlyMap<string, string>,
  precedingUserItemId: string | null,
  inFlightUserItemId: string | null
): string {
  const key = turn.userItemId
  if (key === undefined) {
    return precedingUserItemId ?? turnItemId
  }
  if (userItemIds.has(key)) {
    return key
  }
  const aliased = aliases.get(key)
  if (aliased === undefined || !userItemIds.has(aliased)) {
    return inFlightUserItemId ?? turnItemId
  }
  return inFlightUserItemId !== null && steeredInto.get(aliased) === turnItemId
    ? inFlightUserItemId
    : aliased
}
