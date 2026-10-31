// Derive cut-turn notices from durable journal turns for desktop/mobile, including old journals and mid-settle quits.
// Do not duplicate host-written stop explanations; derived rows are never stored.

import { agentSessionFailureFact, readAgentSessionFailureFact } from '../../agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../agent-session-failure-words'
import { agentJournalItemKey, parseAgentJournalItemKey } from '../../agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../agent-session-journal-types'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from '../../agent-session-turn-record'
import { agentTurnVerdict } from '../../agent-turn-outcome'
import {
  PROVIDER_EXIT_ROW_PREFIX,
  RESTART_CONTINUATION_ROW_PREFIX,
  STALE_SESSION_ROW_PREFIX
} from '../../agent-session-stop-row-identity'
import { isStructuredAgentSessionStartFailureRow } from '../../structured-agent-session-start-failure-row-key'
import { hostStatesTurnScopes } from '../../native-chat-turn-membership'

const CUT_TURN_NOTICE_ROW = 'cut-turn-notice:'

type CutTurnNoticeContext = Pick<AgentSessionFailureWordsContext, 'agentName'>

function rootTurnVerdict(
  item: AgentJournalRenderItem
): ReturnType<typeof agentTurnVerdict> | 'none' {
  const turn = readAgentJournalTurn(item.body)
  return turn && isRootAgentJournalItem(item)
    ? agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
    : 'none'
}

/** Root turns that ended interrupted with no verdict, so nobody asked for the stop. */
function isCutRootTurn(item: AgentJournalRenderItem): boolean {
  return rootTurnVerdict(item) === 'interruption'
}

/** Match stop facts/writer identity, never tone alone (in-turn agent errors may be refusals).
 * exit explains a stop; owner-death explains the cut even after new sends; toned restart notes explain refused/disconnected/unconfirmed continuation.
 * Successful continuation notes have no tone; failed-start rows concern starts. */
function stopExplanation(
  item: AgentJournalRenderItem
): 'exit' | 'owner-death' | 'not-continued' | null {
  if (
    item.body.kind !== 'status' ||
    readAgentJournalTurn(item.body) ||
    isStructuredAgentSessionStartFailureRow(item.itemId)
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  const clientMessageId = identity?.provider === 'orca' ? identity.clientMessageId : ''
  if (clientMessageId.startsWith(STALE_SESSION_ROW_PREFIX)) {
    return 'owner-death'
  }
  if (
    readAgentSessionFailureFact(item.body.failure)?.kind === 'providerExited' ||
    clientMessageId.startsWith(PROVIDER_EXIT_ROW_PREFIX)
  ) {
    return 'exit'
  }
  const { tone } = item.body
  return clientMessageId.startsWith(RESTART_CONTINUATION_ROW_PREFIX) &&
    (tone === 'error' || tone === 'warning')
    ? 'not-continued'
    : null
}

/** Match scoped explanations or nearby conversation/legacy-unscoped rows. Exit requires no intervening send;
 * proven owner death and restart notes after their continuation message explain the cut until another turn begins. */
function explainedCutTurns(items: readonly AgentJournalRenderItem[]): Set<string> {
  const explained = new Set<string>()
  let cutNoSendSince: string | null = null
  let cutNoTurnSince: string | null = null
  for (const item of items) {
    const verdict = rootTurnVerdict(item)
    if (verdict !== 'none') {
      cutNoSendSince = cutNoTurnSince = verdict === 'interruption' ? item.itemId : null
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user' && isRootAgentJournalItem(item)) {
      cutNoSendSince = null
      continue
    }
    const explanation = stopExplanation(item)
    if (explanation === null) {
      continue
    }
    const scope = item.turnScope
    const preceding = explanation === 'exit' ? cutNoSendSince : cutNoTurnSince
    if (scope?.kind === 'turn') {
      explained.add(scope.turnItemId)
    } else if (preceding !== null) {
      explained.add(preceding)
    }
  }
  return explained
}

/** Last scoped row, or journal-order row for legacy hosts; a new root turn ends the run. */
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
  {
    after: AgentJournalRenderItem
    statesScopes: boolean
    agentName: string | undefined
    notice: AgentJournalRenderItem
  }
>()

function cutTurnNotice(
  turnItem: AgentJournalRenderItem,
  after: AgentJournalRenderItem,
  statesScopes: boolean,
  context: CutTurnNoticeContext
): AgentJournalRenderItem {
  const cached = noticeCache.get(turnItem)
  if (
    cached?.after === after &&
    cached.statesScopes === statesScopes &&
    cached.agentName === context.agentName
  ) {
    return cached.notice
  }
  const notice: AgentJournalRenderItem = {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `${CUT_TURN_NOTICE_ROW}${turnItem.itemId}`
    }),
    revision: 0,
    body: {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        ...context,
        surface: 'row'
      }),
      tone: 'error'
    },
    // Just after the turn's last row and before anything the journal wrote next.
    sequence: after.sequence,
    sequenceIndex: (after.sequenceIndex ?? 0) + 0.5,
    observedAt: readAgentJournalTurn(turnItem.body)?.completedAt ?? after.observedAt,
    // A scope on a journal that states none would change how every other row is placed.
    ...(statesScopes ? { turnScope: { kind: 'turn' as const, turnItemId: turnItem.itemId } } : {})
  }
  noticeCache.set(turnItem, { after, statesScopes, agentName: context.agentName, notice })
  return notice
}

/** Add one provider-exit-worded notice after each unexplained cut root turn’s last row. Return the same items reference when unchanged. */
export function withNativeChatCutTurnNotices(
  items: readonly AgentJournalRenderItem[],
  context: CutTurnNoticeContext = {}
): readonly AgentJournalRenderItem[] {
  const explained = explainedCutTurns(items)
  const statesScopes = hostStatesTurnScopes(items)
  const noticesAfter = new Map<number, AgentJournalRenderItem[]>()
  items.forEach((item, index) => {
    if (isCutRootTurn(item) && !explained.has(item.itemId)) {
      const last = lastRowOfTurn(items, index, statesScopes)
      const notice = cutTurnNotice(item, items[last]!, statesScopes, context)
      noticesAfter.set(last, [...(noticesAfter.get(last) ?? []), notice])
    }
  })
  if (noticesAfter.size === 0) {
    return items
  }
  return items.flatMap((item, index) => [item, ...(noticesAfter.get(index) ?? [])])
}
