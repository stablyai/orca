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
  /** The digest's tool name, so a batch member of another tool needs no digest. */
  toolName?: string
}

/**
 * Host-private: a completed tool batch's calls as the provider sent them. Admitting one costs nothing;
 * a member is read only once a represented request's scope admits the batch, and dies with the decision.
 */
export type ClaudeToolBatchFacts = { calls: readonly unknown[] }

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
        ...(providerToolUseId ? { providerToolUseId } : {}),
        ...(toolName ? { toolName } : {})
      }
    }
  }
  if (eventName === 'PostToolBatch' && Array.isArray(raw.tool_calls)) {
    return { claudeBatch: { calls: raw.tool_calls } }
  }
  return {}
}

/** Each call's digest, at most once however many decisions consult it; dies with the call. */
const callDigests = new WeakMap<Record<string, unknown>, string | undefined>()

function callDigest(call: Record<string, unknown>): string | undefined {
  if (!callDigests.has(call)) {
    callDigests.set(call, digest(readString(call, 'tool_name'), call.tool_input))
  }
  return callDigests.get(call)
}

/** The batch lists the request: by the id the provider gave it, else by its whole input. */
export function claudeBatchListsRequest(
  batch: ClaudeToolBatchFacts,
  request: ClaudePermissionRequestFacts
): boolean {
  const { providerToolUseId, digest: requestDigest, toolName } = request
  if (providerToolUseId) {
    return batch.calls.some(
      (call) => isRecord(call) && readString(call, 'tool_use_id') === providerToolUseId
    )
  }
  return (
    requestDigest !== undefined &&
    batch.calls.some(
      (call) =>
        isRecord(call) &&
        (toolName === undefined || readString(call, 'tool_name') === toolName) &&
        callDigest(call) === requestDigest
    )
  )
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
