import {
  finishAgentSessionSteps,
  flatMapAgentSessionSteps
} from '../../agent-session/agent-session-projection-steps'
import { inSendOrderSteps } from '../native-chat-send-order'
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
import type { AgentSessionLatestTurn } from '../../agent-session/agent-session-wire'
/** Map root records to present user openers via direct/provider-adopted ids; older unnamed records use the nearest preceding user row.
 * Before Codex echoes an opener, use its in-flight submission or host-attributed take-back; otherwise anchor on the record.
 * A steer may echo the shared provider key first, but the earliest in-flight send opened the turn. */
export function* structuredAgentTurnAnchorSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  /** Anchored too while it runs with its record above the loaded rows; nothing loaded precedes it. */
  latestTurn?: AgentSessionLatestTurn | null
): Generator<void, ReadonlyMap<string, string>> {
  const userItemIds = new Set<string>()
  for (const item of items) {
    if (
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      item.turnScope?.kind !== 'unknown'
    ) {
      userItemIds.add(item.itemId)
    }
    yield
  }
  const steeredInto = new Map<string, string>()
  for (const item of items) {
    yield
    if (item.turnScope?.kind === 'turn' && userItemIds.has(item.itemId)) {
      steeredInto.set(item.itemId, item.turnScope.turnItemId)
    }
    yield
  }
  const aliases = new Map<string, string>()
  // Codex steers reuse the running turn’s provider key; the earliest submission naming it is the opener.
  for (const submission of submissions) {
    yield
    if (submission.providerItemId && !aliases.has(submission.providerItemId)) {
      aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  // Handed over and not echoed yet; a send still queued opens nothing ahead of a turn record.
  const inFlight = new Set<string>()
  const takenBack: AgentJournalSubmission[] = []
  const itemsById = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    itemsById.set(item.itemId, item)
    yield
  }
  for (const submission of submissions) {
    yield
    if (
      submission.dispatchState === 'pending' &&
      !submission.providerItemId &&
      !isQueuedAgentJournalSubmission(submission)
    ) {
      inFlight.add(agentJournalSubmissionKey(submission.clientMessageId))
    }
    if (
      !submission.providerItemId &&
      submission.queuedMessageId === undefined &&
      submission.resolvedAt !== null &&
      dispatchWasWithdrawn(submission)
    ) {
      takenBack.push(submission)
    }
    yield
  }
  const openedBy = yield* stoppedTurnOpenerSteps(takenBack)
  const unstated = yield* inSendOrderSteps(
    yield* flatMapAgentSessionSteps(takenBack, (submission) => {
      const sent = itemsById.get(agentJournalSubmissionKey(submission.clientMessageId))
      return submission.answeredInTurn === undefined && sent ? [{ sent, submission }] : []
    }),
    ({ submission }) => submission
  )
  const claimed = new Set<string>()
  const anchors = new Map<string, string>()
  let precedingUserItemId: string | null = null
  let inFlightSinceLastTurn: string | null = null
  for (const item of items) {
    yield
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
        let opener: (typeof unstated)[number] | undefined
        for (const candidate of unstated) {
          if (
            !claimed.has(candidate.sent.itemId) &&
            sentBeforeAndTakenBackAfter(item, turn, candidate.submission, candidate.sent)
          ) {
            opener = candidate
            break
          }
          yield
        }
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
export function* stoppedTurnOpenerSteps(
  takenBack: readonly AgentJournalSubmission[]
): Generator<void, ReadonlyMap<string, string>> {
  const openers = new Map<string, string>()
  for (const { answeredInTurn, clientMessageId } of takenBack) {
    yield
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

export function structuredAgentTurnAnchors(
  ...args: Parameters<typeof structuredAgentTurnAnchorSteps>
): ReadonlyMap<string, string> {
  return finishAgentSessionSteps(structuredAgentTurnAnchorSteps(...args))
}
export function stoppedTurnOpeners(
  takenBack: readonly AgentJournalSubmission[]
): ReadonlyMap<string, string> {
  return finishAgentSessionSteps(stoppedTurnOpenerSteps(takenBack))
}
