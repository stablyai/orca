import {
  applyMailDisplayProjection,
  type MailDisplayProjection
} from '../../../shared/agent-session/mail-display-report'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

/** One item whole, as the host keeps it; null when the host no longer has it. Call only after
 *  `supportsStructuredAgentSessionItemDetail`; a failed read rejects. */
export async function readStructuredAgentSessionItem(
  target: RuntimeClientTarget,
  sessionId: string,
  itemId: string
): Promise<AgentJournalRenderItem | null> {
  const result = await callRuntimeRpc<{
    item: AgentJournalRenderItem | null
    mailDisplayReports?: MailDisplayProjection
  }>(target, 'agentSession.item', { sessionId, itemId })
  return result?.item
    ? applyMailDisplayProjection([result.item], result.mailDisplayReports)[0]
    : null
}
