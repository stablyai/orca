// Which turn each transcript row belongs to, and which turn is live, read from the turn record
// rather than from position.
//
// A turn's anchor is the user entry that opened it — its record's `userItemId`, directly or
// through the provider item a submission adopted — or, for a turn no entry opened (one the
// provider resumed on its own), the turn record itself. A row belongs to the turn its stated scope
// names; a row scoped to the conversation, or to a turn the journal no longer holds, belongs to
// none. A host that states no scope is read by journal order, and by position where that names
// nothing.
// Shared by desktop and mobile, whose keys must agree.

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
import type { NativeChatRole } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { inSendOrder } from './native-chat-send-order'
import { runningStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'
import { nativeChatOpeningTurnKey } from './native-chat-messages-waiting-behind-live-turn'
import type { AgentSessionLatestTurn } from './agent-session-wire'

/** Whether the host writing this journal states each row's turn. Only a host that runs `/compact`
 *  as a turn of the send path does, so this is also how a client tells that host from an older one. */
export function hostStatesTurnScopes(items: readonly AgentJournalRenderItem[]): boolean {
  return items.some((item) => item.turnScope !== undefined)
}

export type NativeChatTurnJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
  /** The host's newest turn record: it names the live turn, and anchors it while it runs when the
   *  record is not loaded, so the turn's loaded rows still draw under its bar. Absent from older
   *  hosts. */
  latestTurn?: AgentSessionLatestTurn | null
}

/**
 * Each root turn record's anchor, by the record's item id. `userItemId` resolves to a present user
 * entry, directly or through a submission's adopted provider item; a record that names no entry
 * falls back to the nearest user entry before it, which only older hosts write. A key nothing
 * resolves yet is the send still in flight ahead of the record — Codex reports a turn open before
 * it echoes the send — or one a Stop took back before that echo, which the host names as answered
 * into the turn; with none, the turn anchors on its own record. A steer Codex echoes before the
 * send that opened its turn names that turn's key first, yet the send still in flight ahead of the
 * record opened it.
 */
export function structuredAgentTurnAnchors(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  /** Anchored too while it runs with its record above the loaded rows; nothing loaded precedes it. */
  latestTurn?: AgentSessionLatestTurn | null
): ReadonlyMap<string, string> {
  const userItemIds = new Set(
    items.flatMap((item) =>
      item.body.kind === 'message' && item.body.role === 'user' ? [item.itemId] : []
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
  // Codex folds a send issued mid-turn into the running turn under the SAME provider key, so the
  // earliest submission that names a key is the prompt that opened the turn.
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
  // A send a Stop took back after its turn opened but before the provider echoed it: the record
  // still names the provider's key, and the host names the turn the send was answered into, or
  // none (null). A rejection written before that field is placed by journal order instead.
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

/** For each turn a taken-back send started (`answeredInTurn.via` is `start`), that send's item id.
 *  One steered into a turn opened none, nor one joined in a way this build does not know. */
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

/** For a rejection written before the host named turns: whether its send was sent before a turn
 *  record and taken back after it. By journal order where the host publishes where it was sent (it
 *  has moved the row to the take-back): kept for good, as old chats keep those rows, and it draws
 *  them exactly as before. Else, on a host that publishes neither field, by its row's place and by
 *  times, which a resume rewrites to whole seconds; Temporary, until a host version floor. */
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
  /** The turn live now, whose bar carries the running clock and whose rows stay live: the running
   *  root turn's anchor, else the newest user row's turn (a send whose turn has not opened yet). A
   *  turn the provider opened on its own is live without one. */
  liveTurnKey: string | undefined
  /** Row indexes in the order the transcript draws them (`nativeChatTurnDrawOrder`), or null when
   *  that is the order given. */
  drawOrder: readonly number[] | null
  /** The live turn's key while its record is above the loaded rows: those rows are only its tail,
   *  so nothing may total them as the whole turn. */
  partialTurnKey?: string
}

type NativeChatTurnMember = { id: string; role: NativeChatRole; unsent?: true }

/**
 * Places each row in its turn. A user entry that anchors a turn, or is scoped to none, keys
 * itself; one delivered into a running turn (a steer) takes that turn's key. A host that states no
 * scope is read by journal order instead (`nativeChatJournalOrderTurnKeys`). `opensTurn` narrows
 * which rows may key themselves, for rows that interleave a subagent's with the conversation's. A
 * message shown as not sent is in no turn, so it is never the live one.
 */
export function nativeChatTurnMembership(
  messages: readonly NativeChatTurnMember[],
  journal?: NativeChatTurnJournal | null,
  opensTurn: NativeChatOpensTurn = nativeChatUserRowOpensTurn
): NativeChatTurnMembership {
  const opens: NativeChatOpensTurn = (message) => !isUnsent(message) && opensTurn(message)
  if (!journal) {
    const turnKeys = withoutUnsent(messages, nativeChatRowTurnKeys(messages, null, opens))
    return { turnKeys, liveTurnKey: newestUserTurnKey(messages, turnKeys), drawOrder: null }
  }
  const anchors = structuredAgentTurnAnchors(journal.items, journal.submissions, journal.latestTurn)
  const running = runningStructuredAgentSessionTurnScope(journal)
  if (!hostStatesTurnScopes(journal.items)) {
    const recordKeys = namedRecordKeys(journal.items, anchors)
    const turnKeys = withoutUnsent(
      messages,
      nativeChatRowTurnKeys(
        messages,
        nativeChatJournalOrderTurnKeys(journal.items, recordKeys),
        opens
      )
    )
    const runningNamed = running.kind === 'turn' ? recordKeys.get(running.turnItemId) : null
    return {
      turnKeys,
      liveTurnKey:
        runningNamed ??
        nativeChatOpeningTurnKey(messages, turnKeys, journal) ??
        newestUserTurnKey(messages, turnKeys),
      drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, anchoringUserItems(recordKeys))
    }
  }
  const runningKey = running.kind === 'turn' ? anchors.get(running.turnItemId) : undefined
  const anchoring = new Set(anchors.values())
  const scopes = new Map(journal.items.map((item) => [item.itemId, item.turnScope]))
  const runningRecordLoaded = running.kind === 'turn' && scopes.has(running.turnItemId)
  const turnKeys = messages.map((message) => {
    if (message.unsent === true) {
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
    liveTurnKey:
      runningKey ??
      nativeChatOpeningTurnKey(messages, turnKeys, journal) ??
      newestUserTurnKey(messages, turnKeys),
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

/** Each root record's anchor, or null for a record that names no opener (only older hosts write
 *  one): such a record owns no rows, which keep their position. */
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

/** Whether a row belongs to the turn running now. Liveness is the owning turn's, not the newest
 *  prompt's: a running turn's rows stay live while a newer message waits behind it. */
export function isNativeChatRowInLiveWorkingTurn(
  turnKey: string | undefined,
  liveTurnKey: string | undefined,
  working: boolean
): boolean {
  return working && (liveTurnKey ? turnKey === liveTurnKey : turnKey === undefined)
}

function newestUserTurnKey(
  messages: readonly NativeChatTurnMember[],
  turnKeys: readonly (string | undefined)[]
): string | undefined {
  const index = messages.findLastIndex(
    (message) => message.role === 'user' && message.unsent !== true
  )
  return index === -1 ? undefined : turnKeys[index]
}
