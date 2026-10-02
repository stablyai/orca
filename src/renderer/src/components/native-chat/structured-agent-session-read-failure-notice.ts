// What the structured chat says when reading its history failed: the notice table's words for the
// refusal the read met, never the host's message or code.

import {
  agentSessionReadHistoryRefusalParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import { agentSessionNoticeSaysThisChatUnread } from '../../../../shared/agent-session-write-notice-copy'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session-wire-refusals'
import { isFinalAgentSessionReadRefusal } from '../../../../shared/structured-agent-session-read-refusal'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

export type StructuredAgentSessionReadFailureNotice = {
  text: string
  /** The host named the situation, so the words say more than that the history did not load. */
  named: boolean
  /** Nothing the read retries gets past it, so the pane no longer says it keeps trying. */
  final: boolean
  /** The words already say this chat's history didn't load, so the pane need not say it again. */
  saysUnread: boolean
}

export function structuredAgentSessionReadFailureNotice(
  refusal: AgentSessionRefusalReference | undefined
): StructuredAgentSessionReadFailureNotice {
  // The pane reconnects on its own, so it is the Retry beside the words.
  const parts = refusal
    ? agentSessionReadHistoryRefusalParts(refusal.code, refusal.details, { retryControl: true })
    : agentSessionWriteNotDoneParts('read-history')
  return {
    text: agentSessionWriteNoticeText(parts),
    named: refusal?.details?.reason !== undefined,
    final: isFinalAgentSessionReadRefusal(refusal),
    saysUnread: agentSessionNoticeSaysThisChatUnread(parts)
  }
}
