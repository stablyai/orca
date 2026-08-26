import type { ToolSnapshot } from '../listener-event'
import { deriveToolInputPreview, hasOwnField, readString, toolUpdate } from '../tool-input-preview'
import { deriveInteractivePrompt } from '../interactive-tool'

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
    // Why: OMP shares this extractor; only derive interactivePrompt for Pi so OMP ask_user_question metadata stays unchanged.
    const interactivePrompt =
      agentKind === 'pi' && (eventName === 'tool_call' || eventName === 'tool_execution_start')
        ? deriveInteractivePrompt(toolName, rawToolInput, eventName)
        : undefined
    return toolUpdate(
      { toolName, toolInput, interactivePrompt },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
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
