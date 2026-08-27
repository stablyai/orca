import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { ToolSnapshot } from './listener-event'
import { parseAgentHookJson } from './request-body'
import { readString, toolUpdate } from './tool-input-preview'
import { normalizeHookEventName } from './provider-event-names'

/** Clear active-tool metadata so a failed tool stops looking in-flight (else the compact sidebar hides the error behind the tool name). */
export function clearActiveToolFieldsUpdate(): ToolSnapshot {
  return toolUpdate(
    { toolName: undefined, toolInput: undefined, interactivePrompt: undefined },
    { hasToolInputField: true }
  )
}

/** Drop the hook envelope keys a plugin merges into event properties so the serialized prompt holds only the question structure. */
export function stripHookEnvelopeKeys(record: Record<string, unknown>): Record<string, unknown> {
  const { hook_event_name: _h, hookEventName: _he, ...rest } = record
  return rest
}

/** One-line description of a tool call for an approval card (Bash command, file path, else clipped JSON). */
export function summarizeApprovalInput(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>
    const direct = obj.command ?? obj.file_path ?? obj.path ?? obj.url ?? obj.pattern
    if (typeof direct === 'string' && direct.length > 0) {
      return direct.length > 200 ? `${direct.slice(0, 200)}…` : direct
    }
  }
  try {
    const json = JSON.stringify(toolInput) ?? ''
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
  } catch {
    return ''
  }
}

/** Normalized JSON envelope for a pending prompt: AskUserQuestion → `{ questions }` (shape kept stable for back-compat); other tool on PermissionRequest → `{ approval }`; else undefined. */
export function deriveInteractivePrompt(
  toolName: string | undefined,
  toolInput: unknown,
  eventName?: unknown
): string | undefined {
  // Why: providers vary casing; any post-tool event means the question is no longer pending — don't recreate its answered card.
  const normalizedEventName = normalizeHookEventName(eventName)
  const isPostToolEvent =
    normalizedEventName === 'post_tool_use' || normalizedEventName === 'post_tool_use_failure'
  if (
    isAskUserQuestionTool(toolName) &&
    !isPostToolEvent &&
    toolInput !== undefined &&
    toolInput !== null
  ) {
    try {
      return JSON.stringify(toolInput)
    } catch {
      // Why: circular/unserializable input from a buggy agent — a missing live card beats throwing in the hook hot path.
      return undefined
    }
  }
  if (eventName === 'PermissionRequest' && typeof toolName === 'string' && toolName.length > 0) {
    try {
      return JSON.stringify({
        approval: { tool: toolName, summary: summarizeApprovalInput(toolInput) }
      })
    } catch {
      return undefined
    }
  }
  return undefined
}

export function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) {
      return value
    }
  }
  return undefined
}

export function parseJsonObjectString(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }
  try {
    const parsed = parseAgentHookJson(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function extractToolResponseText(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse
  }
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    return undefined
  }
  const record = toolResponse as Record<string, unknown>
  const directText = readFirstString(record, ['text_result_for_llm', 'textResultForLlm', 'text'])
  if (directText) {
    return directText
  }
  const content = record.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}
