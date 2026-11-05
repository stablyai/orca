import {
  finishAgentSessionSteps,
  mapAgentSessionSteps,
  setAgentSessionSteps,
  indexAgentSessionSteps
} from '../../agent-session/agent-session-projection-steps'
import { newestNativeChatUserTurnKey } from './native-chat-live-turn-membership'
// Share desktop/mobile keys anchored on the opening user entry or provider-resumed turn record.
// Explicit conversation/missing-turn scopes own no turn; legacy hosts fall back to journal order, then position.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../agent-session/lifecycle/agent-session-turn-record'
import {
  nativeChatJournalOrderTurnKeySteps,
  nativeChatRowTurnKeySteps,
  nativeChatRowTurnKeys,
  nativeChatTurnDrawOrder,
  nativeChatUserRowOpensTurn,
  type NativeChatOpensTurn
} from './native-chat-turn-grouping'
import type { NativeChatMessage, NativeChatRole } from '../native-chat-types'
import { structuredAgentTurnAnchorSteps } from './native-chat-turn-anchors'
export { structuredAgentTurnAnchors, stoppedTurnOpeners } from './native-chat-turn-anchors'
import { runningStructuredAgentSessionTurnScope } from '../../agent-session/view/structured-agent-session-live-turn'
import { nativeChatOpeningTurnKey } from './native-chat-messages-waiting-behind-live-turn'
import type { AgentSessionLatestTurn } from '../../agent-session/agent-session-wire'
import { nativeChatTurnRowAttributionSteps } from './native-chat-turn-row-attribution'

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
  const { turnKeys, anchors, recordKeys, scopes, unresolvedRowIds } = finishAgentSessionSteps(
    nativeChatJournalTurnKeySteps(messages, journal, opensTurn)
  )
  const running = runningStructuredAgentSessionTurnScope(journal)
  if (recordKeys) {
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
  const runningRecordLoaded = running.kind === 'turn' && scopes?.has(running.turnItemId)
  return {
    turnKeys,
    unresolvedRowIds,
    liveTurnKey:
      runningKey ??
      nativeChatOpeningTurnKey(messages, turnKeys, journal) ??
      newestNativeChatUserTurnKey(messages, turnKeys),
    drawOrder: nativeChatTurnDrawOrder(messages, turnKeys, new Set(anchors.values())),
    ...(runningKey !== undefined && !runningRecordLoaded ? { partialTurnKey: runningKey } : {})
  }
}

/** Outline reads need the same attribution, without deriving unused draw-order/live-tail fields. */
export function* nativeChatJournalTurnKeySteps(
  messages: readonly NativeChatTurnMember[],
  journal: NativeChatTurnJournal,
  opensTurn: NativeChatOpensTurn = nativeChatUserRowOpensTurn
) {
  const anchors = yield* structuredAgentTurnAnchorSteps(
    journal.items,
    journal.submissions,
    journal.latestTurn
  )
  let scoped = false
  for (const item of journal.items) {
    scoped ||= item.turnScope !== undefined
    yield
  }
  if (!scoped) {
    const recordKeys = new Map<string, string | null>()
    for (const item of journal.items) {
      const anchor = anchors.get(item.itemId)
      if (anchor !== undefined) {
        recordKeys.set(
          item.itemId,
          readAgentJournalTurn(item.body)?.userItemId === undefined ? null : anchor
        )
      }
      yield
    }
    const journalKeys = yield* nativeChatJournalOrderTurnKeySteps(journal.items, recordKeys)
    const rowKeys = yield* nativeChatTurnRowAttributionSteps(messages, journal.items, journalKeys)
    const owned = yield* nativeChatRowTurnKeySteps(
      messages,
      rowKeys,
      (message) => !isUnsent(message) && opensTurn(message)
    )
    const turnKeys = yield* mapAgentSessionSteps(owned, (key, index) =>
      messages[index]?.unsent === true ? undefined : key
    )
    return { turnKeys, anchors, recordKeys }
  }
  const anchoring = yield* setAgentSessionSteps(anchors.values())
  const scopes = yield* nativeChatTurnRowAttributionSteps(
    messages,
    journal.items,
    yield* indexAgentSessionSteps(
      yield* mapAgentSessionSteps(journal.items, (item) => [item.itemId, item.turnScope] as const)
    )
  )
  const unresolvedRowIds = new Set<string>()
  const turnKeys = yield* mapAgentSessionSteps(messages, (message) => {
    if (scopes.get(message.id)?.kind === 'unknown') {
      unresolvedRowIds.add(message.id)
    }
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
  return { turnKeys, anchors, recordKeys: null, scopes, unresolvedRowIds }
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

function anchoringUserItems(recordKeys: ReadonlyMap<string, string | null>): ReadonlySet<string> {
  return new Set([...recordKeys.values()].filter((key) => key !== null))
}
