import type { ToolSnapshot } from '../listener-event'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { deriveToolInputPreview, hasOwnField, readString, toolUpdate } from '../tool-input-preview'
import { clearActiveToolFieldsUpdate, deriveInteractivePrompt } from '../interactive-tool'
import { serializeOmpPlanReviewPrompt } from '../../omp-plan-review-prompt'

/** OMP's `ask` carries the same questions/options payload as Pi's question tool. */
function serializeQuestionPrompt(toolInput: unknown): string | undefined {
  if (toolInput === undefined || toolInput === null) {
    return undefined
  }
  try {
    return JSON.stringify(toolInput)
  } catch {
    return undefined
  }
}

function serializePlanReviewPrompt(hookPayload: Record<string, unknown>): string | undefined {
  const reviewId = readString(hookPayload, 'review_id')
  const plan = hookPayload.plan
  return reviewId && typeof plan === 'string'
    ? serializeOmpPlanReviewPrompt(reviewId, plan, hookPayload.options)
    : undefined
}

function isPiCompatibleAskTool(
  agentKind: 'pi' | 'omp' | 'prime-agent',
  toolName: string | undefined
): boolean {
  return agentKind === 'omp'
    ? toolName === 'ask'
    : agentKind === 'pi' && isAskUserQuestionTool(toolName)
}

export function extractPiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  agentKind: 'pi' | 'omp' | 'prime-agent'
): ToolSnapshot {
  // Custom modals carry neither approvals nor structured questions.
  if (
    agentKind === 'pi' &&
    (hookPayload.ui_prompt_active === true ||
      eventName === 'ui_prompt_start' ||
      eventName === 'ui_prompt_end')
  ) {
    // A turn may end under a modal; retain its assistant reply instead of the prior preview.
    const assistantText =
      eventName === 'message_end' && hookPayload.role === 'assistant'
        ? readString(hookPayload, 'text')
        : undefined
    return assistantText
      ? { ...clearActiveToolFieldsUpdate(), lastAssistantMessage: assistantText }
      : clearActiveToolFieldsUpdate()
  }
  if (
    eventName === 'tool_call' ||
    eventName === 'tool_execution_start' ||
    eventName === 'tool_execution_end'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    const rawToolInput = hookPayload.tool_input
    const toolInput = deriveToolInputPreview(toolName, rawToolInput)
    const interactivePrompt =
      isPiCompatibleAskTool(agentKind, toolName) &&
      (eventName === 'tool_call' || eventName === 'tool_execution_start')
        ? agentKind === 'omp'
          ? serializeQuestionPrompt(rawToolInput)
          : deriveInteractivePrompt(toolName, rawToolInput, eventName)
        : undefined
    return toolUpdate(
      { toolName, toolInput, interactivePrompt },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
  }
  if (
    agentKind === 'omp' &&
    (eventName === 'tool_approval_requested' || eventName === 'tool_approval_resolved')
  ) {
    return toolUpdate(
      {
        toolName: readString(hookPayload, 'tool_name'),
        toolInput:
          eventName === 'tool_approval_requested' ? readString(hookPayload, 'reason') : undefined,
        interactivePrompt: undefined
      },
      { hasToolInputField: true }
    )
  }
  if (
    agentKind === 'omp' &&
    (eventName === 'plan_review_requested' || eventName === 'plan_review_resolved')
  ) {
    return toolUpdate(
      {
        toolName: undefined,
        toolInput: undefined,
        interactivePrompt:
          eventName === 'plan_review_requested' ? serializePlanReviewPrompt(hookPayload) : undefined
      },
      { hasToolInputField: true }
    )
  }
  if (eventName === 'message_end' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}
