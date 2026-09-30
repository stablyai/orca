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
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import {
  nativeChatJournalOrderTurnKeys,
  nativeChatRowTurnKeys,
  nativeChatTurnDrawOrder
} from './native-chat-turn-grouping'
import type { NativeChatRole } from './native-chat-types'
import { isStructuredAgentSessionCommandTurn } from './structured-agent-session-command-entry'
import { liveStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'

/** Whether the host writing this journal states each row's turn. Only a host that runs `/compact`
 *  as a turn of the send path does, so this is also how a client tells that host from an older one. */
export function hostStatesTurnScopes(items: readonly AgentJournalRenderItem[]): boolean {
  return items.some((item) => item.turnScope !== undefined)
}

export type NativeChatTurnJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
}

/**
 * Each root turn record's anchor, by the record's item id. `userItemId` resolves to a present user
 * entry, directly or through a submission's adopted provider item; a record that names no entry
 * falls back to the nearest user entry before it, which only older hosts write. A key nothing
 * resolves yet is the send still in flight ahead of the record — Codex reports a turn open before
 * it echoes the send — and with none, the turn anchors on its own record.
 */
export function structuredAgentTurnAnchors(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, string> {
  const userItemIds = new Set(
    items.flatMap((item) =>
      item.body.kind === 'message' && item.body.role === 'user' ? [item.itemId] : []
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
  const inFlight = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'pending' && !submission.providerItemId)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
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
    anchors.set(
      item.itemId,
      anchorOf(item.itemId, turn, userItemIds, aliases, precedingUserItemId, inFlightSinceLastTurn)
    )
    inFlightSinceLastTurn = null
  }
  return anchors
}

function anchorOf(
  turnItemId: string,
  turn: AgentJournalTurnLifecycle,
  userItemIds: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
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
  return aliased !== undefined && userItemIds.has(aliased)
    ? aliased
    : (inFlightUserItemId ?? turnItemId)
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
}

/**
 * Places each row in its turn. A user entry that anchors a turn, or is scoped to none, keys
 * itself; one delivered into a running turn (a steer) takes that turn's key. A host that states no
 * scope is read by journal order instead (`nativeChatJournalOrderTurnKeys`).
 */
export function nativeChatTurnMembership(
  messages: readonly { id: string; role: NativeChatRole }[],
  journal?: NativeChatTurnJournal | null
): NativeChatTurnMembership {
  if (!journal) {
    const turnKeys = nativeChatRowTurnKeys(messages)
    return { turnKeys, liveTurnKey: newestUserTurnKey(messages, turnKeys), drawOrder: null }
  }
  const anchors = structuredAgentTurnAnchors(journal.items, journal.submissions)
  const running = liveStructuredAgentSessionTurnScope(journal.items)
  if (!hostStatesTurnScopes(journal.items)) {
    const recordKeys = namedRecordKeys(journal.items, anchors)
    const turnKeys = nativeChatRowTurnKeys(
      messages,
      nativeChatJournalOrderTurnKeys(journal.items, recordKeys)
    )
    const runningNamed = running.kind === 'turn' ? recordKeys.get(running.turnItemId) : null
    return {
      turnKeys,
      liveTurnKey: runningNamed ?? newestUserTurnKey(messages, turnKeys),
      drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, anchoringUserItems(recordKeys))
    }
  }
  const runningKey = running.kind === 'turn' ? anchors.get(running.turnItemId) : undefined
  const anchoring = new Set(anchors.values())
  const scopes = new Map(journal.items.map((item) => [item.itemId, item.turnScope]))
  const turnKeys = messages.map((message) => {
    const scope = scopes.get(message.id)
    const turnKey =
      scope?.kind === 'turn' && scope.turnItemId ? anchors.get(scope.turnItemId) : undefined
    if (message.role !== 'user') {
      return turnKey
    }
    return anchoring.has(message.id) ? message.id : (turnKey ?? message.id)
  })
  return {
    turnKeys,
    liveTurnKey: runningKey ?? newestUserTurnKey(messages, turnKeys),
    drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, anchoring)
  }
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

/**
 * The rows accepted but not yet handed over while a conversation command's turn runs, as a message
 * sent during `/compact` is: the host hands nothing over until the command ends, so they draw after
 * that turn's live activity. Any other running turn takes a send within moments, so it stays put.
 */
export function nativeChatMessagesWaitingBehindLiveTurn(
  messages: readonly { id: string; queued?: true }[],
  items: readonly AgentJournalRenderItem[] | null | undefined
): ReadonlySet<string> {
  const queued = messages.filter((message) => message.queued === true)
  return new Set(
    queued.length > 0 && items && commandTurnRunning(items)
      ? queued.map((message) => message.id)
      : []
  )
}

function commandTurnRunning(items: readonly AgentJournalRenderItem[]): boolean {
  const running = liveStructuredAgentSessionTurnScope(items)
  const bodyOf = (itemId: string) => items.find((item) => item.itemId === itemId)?.body
  return (
    running.kind === 'turn' &&
    isStructuredAgentSessionCommandTurn(readAgentJournalTurn(bodyOf(running.turnItemId)), bodyOf)
  )
}

function newestUserTurnKey(
  messages: readonly { role: NativeChatRole }[],
  turnKeys: readonly (string | undefined)[]
): string | undefined {
  const index = messages.findLastIndex((message) => message.role === 'user')
  return index === -1 ? undefined : turnKeys[index]
}
