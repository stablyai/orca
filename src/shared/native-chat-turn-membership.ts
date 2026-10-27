import {
  unresolvedNativeChatRowIds,
  newestNativeChatUserTurnKey
} from './native-chat-live-turn-membership'
export { isNativeChatRowInLiveWorkingTurn } from './native-chat-live-turn-membership'
// Share desktop/mobile keys anchored on the opening user entry or provider-resumed turn record.
// Explicit conversation/missing-turn scopes own no turn; legacy hosts fall back to journal order, then position.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import {
  nativeChatJournalOrderTurnKeys,
  nativeChatRowTurnKeys,
  nativeChatTurnDrawOrder,
  nativeChatUserRowOpensTurn,
  type NativeChatOpensTurn
} from './native-chat-turn-grouping'
import type { NativeChatMessage, NativeChatRole } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { inSendOrder } from './native-chat/native-chat-send-order'
import { runningStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'
import { nativeChatOpeningTurnKey } from './native-chat-messages-waiting-behind-live-turn'
import type { AgentSessionLatestTurn } from './agent-session-wire'
import { nativeChatTurnRowAttribution } from './native-chat-turn-row-attribution'

/** Turn scopes identify hosts that also run /compact through the send path; older hosts omit them. */
export function hostStatesTurnScopes(items: readonly AgentJournalRenderItem[]): boolean {
  return items.some((item) => item.turnScope !== undefined)
}

export type NativeChatTurnJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
  /** Host’s latest turn anchors live rows when its record is unloaded; older hosts omit it. */
  latestTurn?: AgentSessionLatestTurn | null
  /** The host's answer to whether the session's own agent is working; absent from older hosts. */
  working?: boolean
}

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

export type NativeChatTurnMembership = {
  /** Each row's turn by index: the anchor of the turn it belongs to, or undefined for none. */
  turnKeys: (string | undefined)[]
  /** Running root turn’s anchor, otherwise newest user turn awaiting opening; provider-resumed turns need no user row. */
  liveTurnKey: string | undefined
  drawOrder: readonly number[] | null
  /** Live key whose record is unloaded; its loaded tail must not be totaled as a complete turn. */
  partialTurnKey?: string
  /** Rows whose source cannot identify a turn, including when live work has no anchor yet. */
  unresolvedRowIds?: ReadonlySet<string>
}

type NativeChatTurnMember = Pick<NativeChatMessage, 'id' | 'role' | 'unsent' | 'journalPosition'>

/** Anchoring/unscoped user entries key themselves; steers take their owning turn. Legacy hosts use journal-order keys.
 * opensTurn narrows anchors in interleaved streams; unsent messages belong to no turn and never become live. */
export function nativeChatTurnMembership(
  messages: readonly NativeChatTurnMember[],
  journal?: NativeChatTurnJournal | null,
  opensTurn: NativeChatOpensTurn = nativeChatUserRowOpensTurn
): NativeChatTurnMembership {
  const opens: NativeChatOpensTurn = (message) => !isUnsent(message) && opensTurn(message)
  if (!journal) {
    const turnKeys = withoutUnsent(messages, nativeChatRowTurnKeys(messages, null, opens))
    return {
      turnKeys,
      liveTurnKey: newestNativeChatUserTurnKey(messages, turnKeys),
      drawOrder: null
    }
  }
  const anchors = structuredAgentTurnAnchors(journal.items, journal.submissions, journal.latestTurn)
  const running = runningStructuredAgentSessionTurnScope(journal)
  if (!hostStatesTurnScopes(journal.items)) {
    const recordKeys = namedRecordKeys(journal.items, anchors)
    const journalKeys = nativeChatJournalOrderTurnKeys(journal.items, recordKeys)
    const rowKeys = nativeChatTurnRowAttribution(messages, journal.items, journalKeys)
    const turnKeys = withoutUnsent(messages, nativeChatRowTurnKeys(messages, rowKeys, opens))
    const runningNamed = running.kind === 'turn' ? recordKeys.get(running.turnItemId) : null
    return {
      turnKeys,
      liveTurnKey:
        runningNamed ??
        nativeChatOpeningTurnKey(messages, turnKeys, journal) ??
        newestNativeChatUserTurnKey(messages, turnKeys),
      drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, anchoringUserItems(recordKeys))
    }
  }
  const runningKey = running.kind === 'turn' ? anchors.get(running.turnItemId) : undefined
  const anchoring = new Set(anchors.values())
  const scopes = nativeChatTurnRowAttribution(
    messages,
    journal.items,
    new Map(journal.items.map((item) => [item.itemId, item.turnScope]))
  )
  const runningRecordLoaded = running.kind === 'turn' && scopes.has(running.turnItemId)
  const unresolvedRowIds = unresolvedNativeChatRowIds(messages, scopes)
  const turnKeys = messages.map((message) => {
    if (message.unsent === true || unresolvedRowIds.has(message.id)) {
      return undefined
    }
    const scope = scopes.get(message.id)
    const turnKey =
      scope?.kind === 'turn' && scope.turnItemId ? anchors.get(scope.turnItemId) : undefined
    if (!opensTurn(message)) {
      return turnKey
    }
    return anchoring.has(message.id) ? message.id : (turnKey ?? message.id)
  })
  return {
    turnKeys,
    unresolvedRowIds,
    liveTurnKey:
      runningKey ??
      nativeChatOpeningTurnKey(messages, turnKeys, journal) ??
      newestNativeChatUserTurnKey(messages, turnKeys),
    drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, anchoring),
    ...(runningKey !== undefined && !runningRecordLoaded ? { partialTurnKey: runningKey } : {})
  }
}

function isUnsent(message: { id: string; role: NativeChatRole }): boolean {
  return 'unsent' in message && message.unsent === true
}

/** An unsent row neither keys a turn nor inherits the one before it. */
function withoutUnsent(
  messages: readonly NativeChatTurnMember[],
  turnKeys: (string | undefined)[]
): (string | undefined)[] {
  return turnKeys.map((turnKey, index) => (messages[index]?.unsent === true ? undefined : turnKey))
}

/** Legacy root records without named openers own no rows; preserve positional grouping. */
function namedRecordKeys(
  items: readonly AgentJournalRenderItem[],
  anchors: ReadonlyMap<string, string>
): ReadonlyMap<string, string | null> {
  const keys = new Map<string, string | null>()
  for (const item of items) {
    const anchor = anchors.get(item.itemId)
    if (anchor !== undefined) {
      keys.set(
        item.itemId,
        readAgentJournalTurn(item.body)?.userItemId === undefined ? null : anchor
      )
    }
  }
  return keys
}

function anchoringUserItems(recordKeys: ReadonlyMap<string, string | null>): ReadonlySet<string> {
  return new Set([...recordKeys.values()].filter((key) => key !== null))
}
