import { readFirstString } from './interactive-tool'
import type { HookListenerState } from './listener-state'
import { deriveToolInputPreview, readString } from './tool-input-preview'
import { readClaudeBatchSettledRequests } from './claude-settled-permission-requests'

/** The fields that tie a Claude PermissionRequest to the PreToolUse it is asking about. */
export type ClaudeToolRequestFields = {
  toolAgentId?: string
  toolAgentType?: string
  toolName?: string
  toolInput?: string
}

export type ClaudeToolRequest = ClaudeToolRequestFields & {
  toolUseId: string
  /** A PermissionRequest asked about this call and no Post* or batch end has settled it. */
  permissionPending?: true
}

/** PermissionRequest omits tool_use_id; it asks about a PreToolUse with the same owner, tool and input. */
export function claudePermissionNamesToolUse(
  toolUse: ClaudeToolRequestFields,
  permission: ClaudeToolRequestFields
): boolean {
  return (
    toolUse.toolAgentId === permission.toolAgentId &&
    toolUse.toolAgentType === permission.toolAgentType &&
    toolUse.toolName !== undefined &&
    toolUse.toolName === permission.toolName &&
    toolUse.toolInput === permission.toolInput
  )
}

function readRequestFields(hookPayload: Record<string, unknown>): ClaudeToolRequestFields {
  const toolName = readString(hookPayload, 'tool_name')
  return {
    toolAgentId: readFirstString(hookPayload, ['agent_id', 'agentId']),
    toolAgentType: readString(hookPayload, 'agent_type'),
    toolName,
    toolInput: deriveToolInputPreview(toolName, hookPayload.tool_input)
  }
}

// Why a bound: calls Claude never resolves (an interrupt) must not accumulate; extra matches only stop naming.
const MAX_OPEN_TOOL_USES = 32
// Only a session that starts fresh retires the old session's calls; compaction and children keep them.
const CLAUDE_FRESH_SESSION_SOURCES: ReadonlySet<unknown> = new Set(['startup', 'resume', 'clear'])

/** Give a Claude PermissionRequest the tool_use_id of the one open call it asks about, so its wait can be settled by request. */
export function withClaudeToolRequestId(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const toolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const fields = readRequestFields(hookPayload)
  const ended = endedToolUseIds(eventName, toolUseId, fields.toolAgentId, hookPayload)
  const open =
    ended === 'all'
      ? []
      : (state.claudeOpenToolUsesByPaneKey.get(paneKey) ?? []).filter((call) => !ended(call))
  if (eventName === 'PreToolUse' && toolUseId) {
    open.push({ ...fields, toolUseId })
  }
  // Parallel calls interleave their hooks, so the request is the open call it matches, never just the latest.
  const asked =
    eventName !== 'PermissionRequest'
      ? []
      : open.filter((call) =>
          toolUseId ? call.toolUseId === toolUseId : claudePermissionNamesToolUse(call, fields)
        )
  for (const call of asked) {
    // An ambiguous request marks every call it could be, so none is cleared while it may still be on screen.
    call.permissionPending = true
  }
  if (open.length > 0) {
    state.claudeOpenToolUsesByPaneKey.set(paneKey, open.slice(-MAX_OPEN_TOOL_USES))
  } else {
    state.claudeOpenToolUsesByPaneKey.delete(paneKey)
  }
  return !toolUseId && asked.length === 1
    ? { ...hookPayload, tool_use_id: asked[0].toolUseId }
    : hookPayload
}

/** True while some open call still has a permission request nobody has settled. */
export function claudeHasPendingPermission(state: HookListenerState, paneKey: string): boolean {
  return (
    state.claudeOpenToolUsesByPaneKey.get(paneKey)?.some((call) => call.permissionPending) === true
  )
}

function endedToolUseIds(
  eventName: unknown,
  toolUseId: string | undefined,
  toolAgentId: string | undefined,
  hookPayload: Record<string, unknown>
): 'all' | ((call: ClaudeToolRequest) => boolean) {
  if (
    eventName === 'SessionStart' &&
    toolAgentId === undefined &&
    CLAUDE_FRESH_SESSION_SOURCES.has(hookPayload.source)
  ) {
    return 'all'
  }
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    return (call) => call.toolUseId === toolUseId
  }
  if (eventName === 'PostToolBatch') {
    const settled = new Set(readClaudeBatchSettledRequests(hookPayload)?.map((r) => r.toolUseId))
    return (call) => settled.has(call.toolUseId)
  }
  // A lead's calls never outlive its turn; background children's can.
  const leadTurnBoundary =
    toolAgentId === undefined &&
    (eventName === 'UserPromptSubmit' || eventName === 'Stop' || eventName === 'StopFailure')
  return (call) => leadTurnBoundary && call.toolAgentId === undefined
}
