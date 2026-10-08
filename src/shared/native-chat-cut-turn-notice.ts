// The one row that says a turn was cut short when the agent stopped without anyone asking (a crash,
// a quit, an eviction, a teardown). Derived on read from the journal, never stored: the turn record
// is the durable fact, so a journal written before this rule, a quit that died mid-settle and any
// future stop cause all read the same. A row the host already wrote about the stop stays the
// explanation, so nothing is said twice. Shared by desktop and mobile, whose transcripts must agree.
// The journal names no cause a reader can see, so the words fit every cause and blame no one.

import { readAgentSessionFailureFact } from './agent-session-failure'
import {
  agentSessionResponseInterruptedBody,
  isAgentSessionInterruptionPresentation
} from './agent-session-host-status-rows'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  cutTurnStopExplanation,
  explainedCutTurns,
  isCutRootTurn
} from './native-chat-cut-turn-explanation'
import { hostStatesTurnScopes } from './native-chat-turn-membership'

const CUT_TURN_NOTICE_ROW = 'cut-turn-notice:'

/** The turn's last row, which the notice follows: one scoped to it, or by journal order on a host
 *  that states no scope. A new root turn ends the order-read run. */
function lastRowOfTurn(
  items: readonly AgentJournalRenderItem[],
  turnIndex: number,
  statesScopes: boolean
): number {
  const turnItemId = items[turnIndex]!.itemId
  let last = turnIndex
  for (let index = turnIndex + 1; index < items.length; index += 1) {
    const item = items[index]!
    if (statesScopes) {
      if (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId) {
        last = index
      }
      continue
    }
    if (readAgentJournalTurn(item.body) && isRootAgentJournalItem(item)) {
      break
    }
    if (!(item.body.kind === 'message' && item.body.role === 'user')) {
      last = index
    }
  }
  return last
}

const noticeCache = new WeakMap<
  AgentJournalRenderItem,
  { after: AgentJournalRenderItem; statesScopes: boolean; notice: AgentJournalRenderItem }
>()

function cutTurnNotice(
  turnItem: AgentJournalRenderItem,
  after: AgentJournalRenderItem,
  statesScopes: boolean
): AgentJournalRenderItem {
  const cached = noticeCache.get(turnItem)
  if (cached?.after === after && cached.statesScopes === statesScopes) {
    return cached.notice
  }
  const notice: AgentJournalRenderItem = {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `${CUT_TURN_NOTICE_ROW}${turnItem.itemId}`
    }),
    revision: 0,
    body: agentSessionResponseInterruptedBody(),
    // Just after the turn's last row and before anything the journal wrote next.
    sequence: after.sequence,
    sequenceIndex: (after.sequenceIndex ?? 0) + 0.5,
    observedAt: readAgentJournalTurn(turnItem.body)?.completedAt ?? after.observedAt,
    // A scope on a journal that states none would change how every other row is placed.
    ...(statesScopes ? { turnScope: { kind: 'turn' as const, turnItemId: turnItem.itemId } } : {})
  }
  noticeCache.set(turnItem, { after, statesScopes, notice })
  return notice
}

const ownerDeathRowCache = new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()

/** A host's row about an agent process gone from under a turn (a reopen's, or a quit's), in the
 *  notice's words and muted. Two shapes, and only these: an older host's red "the agent stopped"
 *  (no presentation, error red or the exit fact), whose evidence only proves the process is gone;
 *  and a row whose presentation says the turn was interrupted (`response-interrupted`, or
 *  `orca-stop`, which names its cause in fields a newer client words) but which is stored red for
 *  clients that fold every other row, so its presentation is kept. Every other stored field is
 *  kept; the failure fact goes with the words it was built from. Any other row is kept as written,
 *  as is an early build's untoned row that quotes the exit's detail. */
function ownerDeathRowAsInterruption(item: AgentJournalRenderItem): AgentJournalRenderItem {
  if (cutTurnStopExplanation(item) !== 'owner-death' || item.body.kind !== 'status') {
    return item
  }
  const { presentation, tone } = item.body
  const storedRed = isAgentSessionInterruptionPresentation(presentation) && tone !== 'notice'
  const legacy =
    presentation === undefined &&
    (tone === 'error' || readAgentSessionFailureFact(item.body.failure)?.kind === 'providerExited')
  if (!storedRed && !legacy) {
    return item
  }
  const cached = ownerDeathRowCache.get(item)
  if (cached) {
    return cached
  }
  const { failure: _failure, ...stored } = item.body
  const reworded = {
    ...item,
    body: {
      ...stored,
      ...agentSessionResponseInterruptedBody(),
      ...(presentation === undefined ? {} : { presentation })
    }
  }
  ownerDeathRowCache.set(item, reworded)
  return reworded
}

/**
 * The journal as the transcript reads it: each root turn cut short with nobody asking, and no row
 * saying so, gets one muted notice right after the turn's last row, and an older host's reopen row
 * about an agent process found gone says the same. Returns `items` itself when neither applies.
 */
export function withNativeChatCutTurnNotices(
  items: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const explained = explainedCutTurns(items)
  const statesScopes = hostStatesTurnScopes(items)
  const noticesAfter = new Map<number, AgentJournalRenderItem[]>()
  let rewords = false
  items.forEach((item, index) => {
    if (isCutRootTurn(item) && !explained.has(item.itemId)) {
      const last = lastRowOfTurn(items, index, statesScopes)
      const notice = cutTurnNotice(item, items[last]!, statesScopes)
      noticesAfter.set(last, [...(noticesAfter.get(last) ?? []), notice])
    }
    rewords ||= ownerDeathRowAsInterruption(item) !== item
  })
  if (noticesAfter.size === 0 && !rewords) {
    return items
  }
  return items.flatMap((item, index) => [
    ownerDeathRowAsInterruption(item),
    ...(noticesAfter.get(index) ?? [])
  ])
}
