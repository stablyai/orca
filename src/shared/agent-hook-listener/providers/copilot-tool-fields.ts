import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import {
  clearActiveToolFieldsUpdate,
  extractToolResponseText,
  parseJsonObjectString,
  readFirstString
} from '../interactive-tool'
import { readLastAssistantFromTranscript } from '../transcript-lines'

export function normalizeCopilotEventName(eventName: unknown): unknown {
  if (typeof eventName !== 'string') {
    return eventName
  }
  const eventMap: Record<string, string> = {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmitted: 'UserPromptSubmit',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    postToolUseFailure: 'PostToolUseFailure',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    agentStop: 'Stop',
    stop: 'Stop',
    errorOccurred: 'ErrorOccurred',
    permissionRequest: 'PermissionRequest',
    notification: 'Notification'
  }
  return eventMap[eventName] ?? eventName
}

export function resolveCopilotEventName(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  const explicit =
    eventName ??
    readFirstString(hookPayload, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType'])
  if (explicit) {
    return explicit
  }
  if (readFirstString(hookPayload, ['initial_prompt', 'initialPrompt'])) {
    return 'SessionStart'
  }
  if (readString(hookPayload, 'prompt')) {
    return 'UserPromptSubmit'
  }
  if (readFirstString(hookPayload, ['notification_type', 'notificationType'])) {
    return 'Notification'
  }
  if (
    readFirstString(hookPayload, ['transcript_path', 'transcriptPath', 'stop_reason', 'stopReason'])
  ) {
    return 'Stop'
  }
  if (hookPayload.error || readFirstString(hookPayload, ['error_context', 'errorContext'])) {
    return 'ErrorOccurred'
  }
  if (
    Array.isArray(hookPayload.toolCalls) ||
    readFirstString(hookPayload, ['tool_name', 'toolName', 'name'])
  ) {
    if (
      hookPayload.tool_result ||
      hookPayload.toolResult ||
      hookPayload.tool_response ||
      hookPayload.toolResponse
    ) {
      return 'PostToolUse'
    }
    return 'PreToolUse'
  }
  return eventName
}

export function readCopilotToolCall(hookPayload: Record<string, unknown>): {
  toolName?: string
  toolInputSource?: unknown
} {
  const toolCalls = hookPayload.toolCalls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {}
  }
  const first = toolCalls[0]
  if (typeof first !== 'object' || first === null) {
    return {}
  }
  const record = first as Record<string, unknown>
  return {
    toolName: readFirstString(record, ['name', 'toolName', 'tool_name']),
    toolInputSource:
      parseJsonObjectString(record.args) ??
      record.args ??
      parseJsonObjectString(record.arguments) ??
      record.arguments
  }
}

export function isAskUserTool(toolName: string | undefined): boolean {
  return toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuser'
}

export function extractCopilotToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (eventName === 'PostToolUseFailure' || eventName === 'ErrorOccurred') {
    Object.assign(update, clearActiveToolFieldsUpdate())
  } else if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const copilotToolCall = readCopilotToolCall(hookPayload)
    const toolName =
      readFirstString(hookPayload, ['tool_name', 'toolName', 'name']) ?? copilotToolCall.toolName
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.toolInput) ??
      deriveToolInputPreview(toolName, hookPayload.toolArgs) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments) ??
      deriveToolInputPreview(toolName, copilotToolCall.toolInputSource)
    Object.assign(
      update,
      toolUpdate(
        { toolName, toolInput },
        {
          hasToolInputField:
            hasAnyOwnField(hookPayload, [
              'tool_input',
              'toolInput',
              'toolArgs',
              'input',
              'arguments'
            ]) || copilotToolCall.toolInputSource !== undefined
        }
      )
    )
    if (isAskUserTool(toolName) && toolInput) {
      update.lastAssistantMessage = toolInput
    }
  }
  if (eventName === 'PostToolUse') {
    const responseText =
      extractToolResponseText(hookPayload.tool_result) ??
      extractToolResponseText(hookPayload.toolResult) ??
      extractToolResponseText(hookPayload.tool_response) ??
      extractToolResponseText(hookPayload.toolResponse)
    if (responseText) {
      update.lastAssistantMessage = responseText
      update.lastAssistantMessageIsToolOutput = true
    }
  }
  if (eventName === 'PostToolUseFailure' || eventName === 'ErrorOccurred') {
    const errorText =
      extractToolResponseText(hookPayload.tool_result) ??
      extractToolResponseText(hookPayload.toolResult) ??
      extractToolResponseText(hookPayload.tool_response) ??
      extractToolResponseText(hookPayload.toolResponse) ??
      readFirstString(hookPayload, ['error_message', 'errorMessage', 'error', 'message'])
    if (errorText) {
      update.lastAssistantMessage = errorText
      update.lastAssistantMessageIsToolOutput = true
    }
  }
  if (eventName === 'Notification') {
    const notificationType = readFirstString(hookPayload, ['notification_type', 'notificationType'])
    if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
      const message = readFirstString(hookPayload, ['message', 'body', 'text', 'title'])
      if (message) {
        update.lastAssistantMessage = message
      }
    }
  }
  if (eventName === 'Stop') {
    const direct = readFirstString(hookPayload, [
      'last_assistant_message',
      'lastAssistantMessage',
      'message'
    ])
    if (direct) {
      update.lastAssistantMessage = direct
    } else {
      const lastFromTranscript = readLastAssistantFromTranscript(
        hookPayload.transcript_path ?? hookPayload.transcriptPath
      )
      if (lastFromTranscript) {
        update.lastAssistantMessage = lastFromTranscript
      } else {
        update.clearLastAssistantMessage = true
      }
    }
  }
  return update
}
