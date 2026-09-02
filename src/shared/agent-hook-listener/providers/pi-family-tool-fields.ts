import type { ToolSnapshot } from '../listener-event'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { deriveToolInputPreview, hasOwnField, readString, toolUpdate } from '../tool-input-preview'
import { deriveInteractivePrompt } from '../interactive-tool'

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
  if (
    eventName === 'tool_call' ||
    eventName === 'tool_execution_start' ||
    eventName === 'tool_execution_end'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    const rawToolInput = hookPayload.tool_input
    const toolInput = deriveToolInputPreview(toolName, rawToolInput)
    // Why: OMP's `ask` uses the same questions/options shape as Pi's question tool.
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
  if (eventName === 'message_end' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}
