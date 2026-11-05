import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { extractToolResponseText } from '../interactive-tool'

export function extractHermesToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'pre_tool_call' ||
    eventName === 'post_tool_call' ||
    eventName === 'pre_approval_request' ||
    eventName === 'post_approval_response'
  ) {
    const toolName =
      readString(hookPayload, 'tool_name') ??
      readString(hookPayload, 'name') ??
      (eventName === 'pre_approval_request' || eventName === 'post_approval_response'
        ? 'approval'
        : undefined)
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      // Why: Hermes has many tool names; fall back to obvious arg fields so a new name still shows a value, not a blank row.
      deriveFallbackToolInputPreview(hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.args) ??
      deriveFallbackToolInputPreview(hookPayload.input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'description')
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      {
        hasToolInputField: hasAnyOwnField(hookPayload, [
          'tool_input',
          'args',
          'input',
          'command',
          'description'
        ])
      }
    )
    if (eventName === 'post_tool_call') {
      const responseText =
        extractToolResponseText(hookPayload.result) ??
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.output)
      if (responseText) {
        update.lastAssistantMessage = responseText
        update.lastAssistantMessageIsToolOutput = true
      }
    }
    return update
  }
  if (eventName === 'post_llm_call') {
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readString(hookPayload, 'assistant_response') ??
      readString(hookPayload, 'response_text')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
