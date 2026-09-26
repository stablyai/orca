// Which turn each transcript row belongs to, and which turn is live, read from the turn record
// rather than from position.
//
// A turn's anchor is the user entry that opened it — its record's `userItemId`, directly or
// through the provider item a submission adopted — or, for a turn no entry opened (one the
// provider resumed on its own), the turn record itself. A row belongs to the turn its stated scope
// names; a row scoped to the conversation, or to a turn the journal no longer holds, belongs to
// none. A host that states no scope leaves the transcript grouped by position, as before.
// Shared by desktop and mobile, whose keys must agree.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatRole } from './native-chat-types'
import { liveStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'

export type NativeChatTurnJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
}

/**
 * Each root turn record's anchor, by the record's item id. `userItemId` resolves to a present user
 * entry, directly or through a submission's adopted provider item; a record that names no entry
 * falls back to the nearest user entry before it, which only older hosts write. Anything else
 * anchors on the record itself.
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
  const anchors = new Map<string, string>()
  let precedingUserItemId: string | null = null
  for (const item of items) {
    if (userItemIds.has(item.itemId)) {
      precedingUserItemId = item.itemId
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (!turn || !isRootAgentJournalItem(item)) {
      continue
    }
    anchors.set(item.itemId, anchorOf(item.itemId, turn, userItemIds, aliases, precedingUserItemId))
  }
  return anchors
}

function anchorOf(
  turnItemId: string,
  turn: AgentJournalTurnLifecycle,
  userItemIds: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
  precedingUserItemId: string | null
): string {
  const key = turn.userItemId
  if (key === undefined) {
    return precedingUserItemId ?? turnItemId
  }
  if (userItemIds.has(key)) {
    return key
  }
  const aliased = aliases.get(key)
  return aliased !== undefined && userItemIds.has(aliased) ? aliased : turnItemId
}

export type NativeChatTurnMembership = {
  /** Each row's turn by index: the anchor of the turn it belongs to, or undefined for none. */
  turnKeys: (string | undefined)[]
  /** The turn live now: the running root turn's anchor, else the newest user row's turn (a send
   *  whose turn has not opened yet). A turn the provider opened on its own is live without one. */
  liveTurnKey: string | undefined
}

/**
 * Places each row in its turn. A user entry that anchors a turn, or is scoped to none, keys
 * itself; one delivered into a running turn (a steer) takes that turn's key.
 */
export function nativeChatTurnMembership(
  messages: readonly { id: string; role: NativeChatRole }[],
  journal?: NativeChatTurnJournal | null
): NativeChatTurnMembership {
  const scoped = journal?.items.some((item) => item.turnScope !== undefined)
  if (!journal || !scoped) {
    const turnKeys = positionalTurnKeys(messages)
    return { turnKeys, liveTurnKey: newestUserTurnKey(messages, turnKeys) }
  }
  const anchors = structuredAgentTurnAnchors(journal.items, journal.submissions)
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
  const running = liveStructuredAgentSessionTurnScope(journal.items)
  const runningKey = running.kind === 'turn' ? anchors.get(running.turnItemId) : undefined
  return { turnKeys, liveTurnKey: runningKey ?? newestUserTurnKey(messages, turnKeys) }
}

function newestUserTurnKey(
  messages: readonly { role: NativeChatRole }[],
  turnKeys: readonly (string | undefined)[]
): string | undefined {
  const index = messages.findLastIndex((message) => message.role === 'user')
  return index === -1 ? undefined : turnKeys[index]
}

/** What a host that states no scope leaves: each user row opens a turn that runs to the next. */
function positionalTurnKeys(
  messages: readonly { id: string; role: NativeChatRole }[]
): (string | undefined)[] {
  let currentTurnKey: string | undefined
  return messages.map((message) => {
    if (message.role === 'user') {
      currentTurnKey = message.id
    }
    return currentTurnKey
  })
}
