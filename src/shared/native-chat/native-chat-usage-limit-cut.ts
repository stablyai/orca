// Derive usage-limit cuts from journal rows on each read for Continue; never store derived state.

import { readAgentJournalTurn } from '../agent-session/lifecycle/records/agent-session-turn-record'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import { readAgentSessionFailureFact } from '../agent-session/failures/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session/journal/agent-session-journal-types'
import type { AgentSessionUsageLimit } from '../agent-session/failures/agent-session-usage-limit'
import type { UsageLimitContinueIdentity } from '../agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import { findInNativeChatTurn, latestNativeChatTurnSinceRequest } from './native-chat-orca-stop-cut'

/** What the agent is sent when the person continues a turn its usage limit ended. */
export const NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE = 'Continue where you left off.'

/** The limit a row reports, when it is a usage-limit row. */
export function nativeChatUsageLimitOfRow(
  item: AgentJournalRenderItem
): AgentSessionUsageLimit | null {
  if (!isRootAgentJournalItem(item) || item.body.kind !== 'status') {
    return null
  }
  const fact = readAgentSessionFailureFact(item.body.failure)
  return fact?.kind === 'usageLimitReached' ? (fact.usageLimit ?? {}) : null
}

export type NativeChatUsageLimitCut = {
  turnItemId: string
  resetsAt?: number
  turnEndedAt?: number
}

/** How long after its reset a cut can still be continued automatically; older cuts stay manual. */
export const NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS = 24 * 60 * 60 * 1000

/** Whether Orca could ever continue this cut by itself: a known reset after its turn ended, at most a day ago. */
export function isNativeChatUsageLimitCutSchedulable(
  cut: NativeChatUsageLimitCut,
  now: number
): cut is NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number } {
  return (
    cut.resetsAt !== undefined &&
    Number.isFinite(cut.resetsAt) &&
    cut.turnEndedAt !== undefined &&
    cut.resetsAt > cut.turnEndedAt &&
    now - cut.resetsAt <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
  )
}

/** The latest root turn, when a usage limit ended it and nothing was sent since. Null otherwise. */
export function latestNativeChatUsageLimitCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[],
  bodyOf?: Parameters<typeof latestNativeChatTurnSinceRequest>[2]
): NativeChatUsageLimitCut | null {
  const latest = latestNativeChatTurnSinceRequest(items, submissions, bodyOf)
  if (!latest || latest.verdict !== 'failure') {
    return null
  }
  const limit = findInNativeChatTurn(items, latest.turnItem.itemId, nativeChatUsageLimitOfRow)
  if (limit === null) {
    return null
  }
  const turn = readAgentJournalTurn(latest.turnItem.body)
  return {
    turnItemId: latest.turnItem.itemId,
    ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
    turnEndedAt: latest.turnItem.recoveredAt ?? turn?.completedAt
  }
}

/** The latest cut's automatic-continue identity, when its reset time is known. */
export function latestUsageLimitContinueIdentity(snapshot: {
  items: readonly AgentJournalRenderItem[]
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
}): UsageLimitContinueIdentity | undefined {
  const cut = latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions)
  return cut?.resetsAt !== undefined && Number.isFinite(cut.resetsAt)
    ? { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt }
    : undefined
}
