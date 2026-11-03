import { createHash } from 'node:crypto'
import { isRecord } from '../agent-status-child-work-value-guards'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from '../agent-status-types'
import { readString } from './tool-input-preview'

/**
 * Host-private facts about the request the host currently represents. The provider omits the request's
 * invocation id, so the digest is only a fingerprint of the whole effective input, never an identity.
 */
export type ClaudePermissionRequestFacts = {
  /** Undefined when the input is missing: an unknown input never matches anything. */
  digest?: string
  /** Only an id the provider itself put on the request; a legacy inherited id is never one. */
  providerToolUseId?: string
}

/** Host-private: each member of a completed tool batch, by its own id and whole-input digest. */
export type ClaudeToolBatchFacts = { members: { toolUseId?: string; digest?: string }[] }

/** The current-state projection a host publishes once its own transition has decided the row. */
export type ClaudePermissionProjection = {
  version: 1
  /** The host held its represented request: the receiver keeps its own copy of that request. */
  held?: true
  /** On replay, the held request itself, so a receiver that missed it can show it. */
  row?: ClaudeProjectedRow
}

export type ClaudeProjectedRow = {
  hookEventName: string
  toolUseId?: string
  toolAgentId?: string
  toolAgentType?: string
  payload: ParsedAgentStatusPayload
}

const MAX_ID_LENGTH = 256

/** Whole tool name and structural input, object keys ordered at every depth. */
function digest(toolName: string | undefined, input: unknown): string | undefined {
  if (!toolName || input === undefined) {
    return undefined
  }
  const canonical = JSON.stringify([toolName, input], (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  )
  return createHash('sha256').update(canonical).digest('hex')
}

/** Facts the Claude producer attaches to an ordinary permission request or a completed tool batch. */
export function readClaudePermissionFacts(
  eventName: unknown,
  raw: Record<string, unknown>
): { claudeRequest?: ClaudePermissionRequestFacts; claudeBatch?: ClaudeToolBatchFacts } {
  const toolName = readString(raw, 'tool_name')
  if (eventName === 'PermissionRequest' && !isAskUserQuestionTool(toolName)) {
    const providerToolUseId = readString(raw, 'tool_use_id')
    return {
      claudeRequest: {
        digest: digest(toolName, raw.tool_input),
        ...(providerToolUseId ? { providerToolUseId } : {})
      }
    }
  }
  if (eventName === 'PostToolBatch' && Array.isArray(raw.tool_calls)) {
    return {
      claudeBatch: {
        members: raw.tool_calls.map((call: unknown) =>
          isRecord(call)
            ? {
                toolUseId: readString(call, 'tool_use_id'),
                digest: digest(readString(call, 'tool_name'), call.tool_input)
              }
            : {}
        )
      }
    }
  }
  return {}
}

function readId(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined
  }
  return typeof value === 'string' && value.trim() && value.length <= MAX_ID_LENGTH
    ? value.trim()
    : null
}

/** Validates a projection off the wire; anything malformed is rejected whole, so legacy ingestion applies. */
export function readClaudePermissionProjection(
  value: unknown
): ClaudePermissionProjection | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.held !== undefined && value.held !== true)
  ) {
    return undefined
  }
  if (value.row === undefined) {
    return { version: 1, ...(value.held ? { held: true } : {}) }
  }
  const row = isRecord(value.row) ? value.row : undefined
  const hookEventName = readId(row?.hookEventName)
  const ids = [readId(row?.toolUseId), readId(row?.toolAgentId), readId(row?.toolAgentType)]
  const payload = normalizeAgentStatusPayload(row?.payload)
  if (!row || !hookEventName || !payload || ids.includes(null)) {
    return undefined
  }
  const [toolUseId, toolAgentId, toolAgentType] = ids
  return {
    version: 1,
    ...(value.held ? { held: true } : {}),
    row: {
      hookEventName,
      ...(toolUseId ? { toolUseId } : {}),
      ...(toolAgentId ? { toolAgentId } : {}),
      ...(toolAgentType ? { toolAgentType } : {}),
      payload
    }
  }
}
