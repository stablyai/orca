import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { extractToolResponseText } from '../interactive-tool'
import { readLastAssistantFromTranscript } from '../transcript-lines'

export function isDroidPermissionNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  // Why: 'confirm' is excluded — it false-positives on benign messages like "task confirmed" that aren't permission prompts.
  return lower.includes('permission') || lower.includes('approve') || lower.includes('approval')
}

export function isDroidIdleNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return lower.includes('waiting for your input') || lower.includes('waiting for input')
}

export function isDroidAskUserTool(toolName: string | undefined): boolean {
  if (!toolName) {
    return false
  }
  return toolName.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuser'
}

export function readDroidToolRiskLevel(hookPayload: Record<string, unknown>): string | undefined {
  const directRisk = readString(hookPayload, 'riskLevel') ?? readString(hookPayload, 'risk_level')
  if (directRisk) {
    return directRisk
  }

  for (const key of ['tool_input', 'input', 'arguments'] as const) {
    const value = hookPayload[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const record = value as Record<string, unknown>
    const nestedRisk = readString(record, 'riskLevel') ?? readString(record, 'risk_level')
    if (nestedRisk) {
      return nestedRisk
    }
  }
  return undefined
}

export function isDroidHighRiskToolUse(hookPayload: Record<string, unknown>): boolean {
  return readDroidToolRiskLevel(hookPayload)?.trim().toLowerCase() === 'high'
}

export function extractDroidToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
    )
    if (eventName === 'PostToolUse') {
      const responseText =
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastAssistantFromTranscript(hookPayload.transcript_path)
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
  }
  return {}
}
