import {
  supportsStructuredAgentSessionQuestionAnswers,
  supportsStructuredAgentSessionPromptCancel
} from '@/runtime/structured-agent-session-client'
import {
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse
} from '../../../../shared/agent-session-question-answer'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session-wire'
import type { StructuredPromptItem } from './structured-agent-session-message-projection'
import type { StructuredAgentSessionAction } from './use-structured-agent-session-mutate'

export async function respondToStructuredAgentSessionPrompt({
  item,
  response,
  action
}: {
  item: StructuredPromptItem
  response: AgentSessionPromptResponse
  action: StructuredAgentSessionAction | null
}): Promise<AgentSessionPromptResult | null> {
  if (!action) {
    return null
  }
  const { body } = item
  const answers = response.kind === 'answers' ? response.answers : []
  const promptTarget = { itemId: item.itemId, expectedRevision: item.revision }
  let fields: Record<string, unknown>
  if (response.kind === 'option') {
    fields = { ...promptTarget, optionId: response.optionId }
  } else if (await supportsStructuredAgentSessionQuestionAnswers(action.target)) {
    // Negotiated before mutate fingerprints the call: older hosts reject the strict field.
    fields = { ...promptTarget, answers }
  } else {
    const optionId =
      body.kind === 'question' ? legacyAgentSessionSelectedOptionId(body, answers) : null
    if (optionId === null) {
      return null
    }
    fields = { ...promptTarget, optionId }
  }
  return action.mutate<AgentSessionPromptResult>(
    body.kind === 'approval' ? 'agentSession.respondToApproval' : 'agentSession.respondToQuestion',
    `agentSession.respondTo:${body.kind}`,
    fields
  )
}

export async function cancelStructuredAgentSessionPrompt(
  action: StructuredAgentSessionAction | null,
  turnId: string | undefined,
  prompt?: { itemId: string; expectedRevision: number }
) {
  if (!action) {
    return null
  }
  const promptTarget = prompt && { ...prompt }
  const promptSupported =
    promptTarget !== undefined && (await supportsStructuredAgentSessionPromptCancel(action.target))
  return action.mutate('agentSession.cancel', 'agentSession.cancel', {
    ...(turnId ? { turnId } : {}),
    ...(promptSupported ? { prompt: promptTarget } : {})
  })
}
