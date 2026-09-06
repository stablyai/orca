import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { deriveInteractivePrompt } from '../interactive-tool'
import { extractToolResponseText } from '../interactive-tool'
import type { AgentHookToolActivity } from '../../agent-hook-relay'

export function extractCodexToolActivity(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): AgentHookToolActivity | undefined {
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') {
    return undefined
  }
  const input = hookPayload.tool_input ?? hookPayload.input ?? hookPayload.arguments
  if (eventName === 'PreToolUse') {
    return input === undefined ? {} : { input }
  }
  const response =
    hookPayload.tool_response ?? hookPayload.tool_output ?? hookPayload.output ?? hookPayload.result
  const responseRecord =
    typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)
      : undefined
  const output =
    extractToolResponseText(response) ??
    (response === undefined ? undefined : JSON.stringify(response))
  return {
    ...(input === undefined ? {} : { input }),
    ...(output !== undefined ? { output } : {}),
    ...(responseRecord?.success === false || responseRecord?.is_error === true
      ? { isError: true }
      : {})
  }
}

export function extractCodexToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PermissionRequest' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const rawInput = hookPayload.tool_input ?? hookPayload.input ?? hookPayload.arguments
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    return toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt: deriveInteractivePrompt(toolName, rawInput, eventName)
      },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
    )
  }
  if (eventName === 'Stop') {
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
