import {
  readClaudeModelFallbackFrame,
  claudeModelFallbackText
} from '../../native-chat/transcript/notices/claude-model-fallback'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../journal/agent-session-turn-notice'
import { readWholeAgentSessionFailureFact } from '../failures/agent-session-failure'
import type { AgentJournalStatusItem } from '../journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../journal/agent-session-journal-turn-scope'
import { readAgentSessionOrcaStop } from '../lifecycle/stopping/agent-session-orca-stop'
import { automationResultNoteOf } from '../../bots/bot-automation-result-note'
import { botMemoryUpdatedNoteOf } from '../../bots/bot-memory-updated-note'
import { botContextNoteOf } from '../../bots/bot-context-note'
import { tidyUpNoteOf } from '../../bots/bot-tidy-up'
import { connectorOfferOf } from '../../bots/bot-connector-offer'
import { botCreateOfferOf } from '../../bots/bot-proposal'
import { botImportDoneOf, botImportPlanOf } from '../../bots/bot-import-cards'
import { botRequestCardOf } from '../../bots/bot-request-card'
import { googleSetupCardOf } from '../../google/google-setup-card'
import { composioSetupCardOf } from '../../composio/composio-setup-card'
import type { NativeChatTextBlock } from '../../native-chat/native-chat-types'
import {
  AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION,
  isAgentSessionLegacyCompactionResult
} from '../conversation-context/agent-session-compaction'

/** A status row as the line a chat paints: named fields only, so a host-only key never leaks. */
export function structuredAgentSessionStatusBlock(
  body: AgentJournalStatusItem,
  turnScope?: AgentJournalTurnScope,
  itemId?: string
): NativeChatTextBlock {
  const failure = readWholeAgentSessionFailureFact(body.failure)
  const orcaStop = readAgentSessionOrcaStop(body.orcaStop)
  const automationResult = automationResultNoteOf(body)
  const botContext = botContextNoteOf(body)
  const botMemoryUpdated = botMemoryUpdatedNoteOf(body)
  const tidyUp = tidyUpNoteOf(body)
  const connectorOffer = connectorOfferOf(body)
  const botCreateOffer = botCreateOfferOf(body)
  const botImportPlan = botImportPlanOf(body)
  const botImportDone = botImportDoneOf(body)
  const botRequest = botRequestCardOf(body)
  const modelFallback =
    !failure && !orcaStop && body.presentation === undefined && body.tone === undefined
      ? readClaudeModelFallbackFrame(body.providerFrame)
      : null
  const googleSetup = googleSetupCardOf(body)
  const composioSetup = composioSetupCardOf(body)
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
    ...(automationResult ? { automationResult } : {}),
    ...(botContext ? { botContext } : {}),
    ...(botMemoryUpdated ? { botMemoryUpdated } : {}),
    ...(tidyUp ? { tidyUp } : {}),
    ...(connectorOffer ? { connectorOffer } : {}),
    ...(botCreateOffer ? { botCreateOffer } : {}),
    ...(botImportPlan ? { botImportPlan } : {}),
    ...(botImportDone ? { botImportDone } : {}),
    ...(botRequest ? { botRequest } : {}),
    ...(googleSetup ? { googleSetup } : {}),
    ...(composioSetup ? { composioSetup } : {}),
    ...(body.forkedFrom
      ? {
          forkedFrom: {
            sessionId: body.forkedFrom.sessionId,
            ...(body.forkedFrom.sourceForked ? { sourceForked: true as const } : {}),
            ...(body.forkedFrom.sourceMissing ? { sourceMissing: true as const } : {})
          }
        }
      : {}),
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
