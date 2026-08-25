import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { clearActiveToolFieldsUpdate, extractToolResponseText } from '../interactive-tool'

export function extractCursorToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'preToolUse' ||
    eventName === 'postToolUse' ||
    eventName === 'postToolUseFailure'
  ) {
    const update: ToolSnapshot = {}
    if (eventName === 'postToolUseFailure') {
      Object.assign(update, clearActiveToolFieldsUpdate())
    } else {
      const toolName = readString(hookPayload, 'tool_name')
      const toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
      Object.assign(
        update,
        toolUpdate(
          { toolName, toolInput },
          { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
        )
      )
    }
    if (eventName === 'postToolUse') {
      const responseText = extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    if (eventName === 'postToolUseFailure') {
      const errorText =
        extractToolResponseText(hookPayload.tool_output) ??
        readString(hookPayload, 'error_message') ??
        readString(hookPayload, 'error')
      if (errorText) {
        update.lastAssistantMessage = errorText
      }
    }
    return update
  }
  if (eventName === 'beforeShellExecution') {
    const command = readString(hookPayload, 'command')
    return toolUpdate(
      { toolName: 'Shell', toolInput: command },
      { hasToolInputField: hasOwnField(hookPayload, 'command') }
    )
  }
  if (eventName === 'beforeMCPExecution') {
    const toolName = readString(hookPayload, 'tool_name') ?? 'MCP'
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'url')
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'command', 'url']) }
    )
  }
  if (eventName === 'afterAgentResponse') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}
