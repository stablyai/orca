import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalStatusItem, AgentJournalTurnScope } from './agent-session-journal-types'
import { readAgentSessionOrcaStop } from './agent-session-orca-stop'
import type { NativeChatTextBlock } from './native-chat-types'
import {
  AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION,
  isAgentSessionLegacyCompactionResult
} from './agent-session-compaction'

/** A status row as the line a chat paints: named fields only, so a host-only key never leaks. */
export function structuredAgentSessionStatusBlock(
  body: AgentJournalStatusItem,
  turnScope?: AgentJournalTurnScope,
  itemId?: string
): NativeChatTextBlock {
  const failure = readWholeAgentSessionFailureFact(body.failure)
  const orcaStop = readAgentSessionOrcaStop(body.orcaStop)
  const presentation =
    body.presentation ??
    (body.tone === 'warning' && itemId !== undefined && isAgentSessionLegacyCompactionResult(itemId)
      ? AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION
      : undefined)
  return {
    type: 'text',
    text: body.text,
    ...(presentation !== undefined ? { presentation } : {}),
    ...(body.contextClear !== undefined ? { contextClear: body.contextClear } : {}),
    ...(body.tone !== undefined ? { tone: body.tone } : {}),
    ...(body.providerFrame ? { providerFrame: body.providerFrame } : {}),
    ...(failure ? { failure } : {}),
    ...(orcaStop
      ? {
          orcaStop: {
            ...orcaStop,
            ...(turnScope?.kind === 'turn' ? { turnItemId: turnScope.turnItemId } : {})
          }
        }
      : {})
  }
}
