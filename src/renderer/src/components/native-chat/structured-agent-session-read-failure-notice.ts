// Render history refusals through the notice table, never raw host messages or codes.

import {
  agentSessionReadHistoryRefusalParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session-wire-refusals'
import { isFinalAgentSessionReadRefusal } from '../../../../shared/structured-agent-session-read-refusal'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

export type StructuredAgentSessionReadFailureNotice = {
  text: string
  /** The host named the situation, so the words say more than that the history did not load. */
  named: boolean
  /** Nothing the read retries gets past it. */
  final: boolean
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
    final: isFinalAgentSessionReadRefusal(refusal)
  }
}
