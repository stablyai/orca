import {
  readClaudeModelFallbackFrame,
  claudeModelFallbackText
} from '../../native-chat/claude-model-fallback'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../journal/agent-session-turn-notice'
import { readWholeAgentSessionFailureFact } from '../failures/agent-session-failure'
import type { AgentJournalStatusItem } from '../journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../journal/agent-session-journal-turn-scope'
import { readAgentSessionOrcaStop } from '../lifecycle/stopping/agent-session-orca-stop'
import type { NativeChatTextBlock } from '../../native-chat/native-chat-types'
import {
  AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION,
  isAgentSessionLegacyCompactionResult
} from '../agent-session-compaction'

/** A status row as the line a chat paints: named fields only, so a host-only key never leaks. */
export function structuredAgentSessionStatusBlock(
  body: AgentJournalStatusItem,
  turnScope?: AgentJournalTurnScope,
  itemId?: string
): NativeChatTextBlock {
  const failure = readWholeAgentSessionFailureFact(body.failure)
  const orcaStop = readAgentSessionOrcaStop(body.orcaStop)
  const modelFallback =
    !failure && !orcaStop && body.presentation === undefined && body.tone === undefined
      ? readClaudeModelFallbackFrame(body.providerFrame)
      : null
  const presentation =
    body.presentation ??
    (modelFallback ? AGENT_SESSION_TURN_NOTICE_PRESENTATION : undefined) ??
    (body.tone === 'warning' && itemId !== undefined && isAgentSessionLegacyCompactionResult(itemId)
      ? AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION
      : undefined)
  return {
    type: 'text',
    text: modelFallback ? claudeModelFallbackText(modelFallback) : body.text,
    ...(presentation !== undefined ? { presentation } : {}),
    ...(body.contextClear !== undefined ? { contextClear: body.contextClear } : {}),
    ...(body.tone !== undefined ? { tone: body.tone } : modelFallback ? { tone: 'notice' } : {}),
    ...(body.providerFrame ? { providerFrame: body.providerFrame } : {}),
    ...(failure ? { failure } : {}),
    ...(body.forkedFrom ? { forkedFrom: { sessionId: body.forkedFrom.sessionId } } : {}),
    ...(failure?.kind === 'usageLimitReached' && turnScope?.kind === 'turn'
      ? { usageLimitTurnItemId: turnScope.turnItemId }
      : {}),
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
