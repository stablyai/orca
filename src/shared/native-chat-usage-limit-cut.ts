// A turn one of the agent's usage limits ended, as its row says, and whether the chat still sits on
// it. Derived from the journal each time, never stored; the chat offers Continue from it.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionUsageLimit } from './agent-session-usage-limit'
import { findInNativeChatTurn, latestNativeChatTurnSinceRequest } from './native-chat-orca-stop-cut'

/** What the agent is sent when the person continues a turn its usage limit ended. */
export const NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE = 'Continue where you left off.'

/** The limit a row reports, when it is a usage-limit row. */
function usageLimitOfRow(item: AgentJournalRenderItem): AgentSessionUsageLimit | null {
  if (!isRootAgentJournalItem(item) || item.body.kind !== 'status') {
    return null
  }
  const fact = readAgentSessionFailureFact(item.body.failure)
  return fact?.kind === 'usageLimitReached' ? (fact.usageLimit ?? {}) : null
}

/** The latest root turn, when a usage limit ended it and nothing was sent since. Null otherwise. */
export function latestNativeChatUsageLimitCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): { turnItemId: string } | null {
  const latest = latestNativeChatTurnSinceRequest(items, submissions)
  return latest?.verdict === 'failure' &&
    findInNativeChatTurn(items, latest.turnItem.itemId, usageLimitOfRow) !== null
    ? { turnItemId: latest.turnItem.itemId }
    : null
}
