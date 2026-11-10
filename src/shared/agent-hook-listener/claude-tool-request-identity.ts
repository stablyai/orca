import { readFirstString } from './interactive-tool'
import { isAskUserQuestionTool } from '../agent-status/lifecycle/agent-question-answered-intent'
import type { HookListenerState } from './listener-state'
import { deriveToolInputPreview, readString } from './tool-input-preview'
import { readClaudeBatchSettledRequests } from './claude-settled-permission-requests'
import { extractPromptText } from './prompt-fields'
import { hasExplicitUserPrompt } from './provider-event-routing'
import { CLAUDE_NEW_SESSION_START_SOURCES } from './providers/claude-session-start-sources'

/** The fields that tie a Claude PermissionRequest to the PreToolUse it is asking about. */
export type ClaudeToolRequestFields = {
  toolAgentId?: string
  toolAgentType?: string
  toolName?: string
  toolInput?: string
}

/** An open tool call, keyed by Claude's own tool_use_id; the only entry that names a request or settles by id. */
export type ClaudeToolCall = ClaudeToolRequestFields & {
  kind: 'tool'
  toolUseId: string
  /** A permission request or question about this call waits on the user; no Post*, batch end or stop has settled it. */
  awaitingUser?: true
}

/**
 * Something on screen that waits on the user and carries no tool_use_id: an MCP dialog, identified by its
 * owner, server and elicitation id, or a blocker whose request Orca cannot identify.
 */
export type ClaudeUserWait = ClaudeToolRequestFields & {
  kind: 'elicitation' | 'unidentified'
  /** Equal keys are the same wait: a dialog's server and id, or a blocker's server or request fields. */
  waitKey: string
}

export type ClaudeToolRequest = ClaudeToolCall | ClaudeUserWait

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

/** Give a Claude PermissionRequest the tool_use_id of the one open call it asks about, so its wait can be settled by request. */
export function withClaudeToolRequestId(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const toolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const fields = readRequestFields(hookPayload)
  const ended = endedRequests(eventName, toolUseId, fields.toolAgentId, hookPayload)
  const open =
    ended === 'all'
      ? []
      : (state.claudeOpenToolUsesByPaneKey.get(paneKey) ?? []).filter((entry) => !ended(entry))
  if (eventName === 'Elicitation') {
    // An MCP dialog waits on the user too; batches never list it, so only its own result or a boundary ends it.
    addUserWait(open, { ...fields, ...elicitationWait(hookPayload) })
  }
  if (eventName === 'PreToolUse' && toolUseId) {
    // A question waits on the user from its PreToolUse, with or without a PermissionRequest.
    open.push({
      ...fields,
      kind: 'tool',
      toolUseId,
      ...(isAskUserQuestionTool(fields.toolName) ? { awaitingUser: true as const } : {})
    })
  }
  // Parallel calls interleave their hooks, so the request is the open call it matches, never just the latest.
  const asked =
    eventName !== 'PermissionRequest'
      ? []
      : open.filter(
          (entry): entry is ClaudeToolCall =>
            entry.kind === 'tool' &&
            (toolUseId
              ? entry.toolUseId === toolUseId
              : claudePermissionNamesToolUse(entry, fields))
        )
  for (const call of asked) {
    // An ambiguous request marks every call it could be, so none is cleared while it may still be on screen.
    call.awaitingUser = true
  }
  if (eventName === 'PermissionRequest' && asked.length === 0) {
    if (toolUseId) {
      open.push({ ...fields, kind: 'tool', toolUseId, awaitingUser: true })
    } else {
      // A request with no observed call (a restarted relay, an evicted call) has no identity to settle by, so it
      // holds until its owner's stop, its turn's end or a fresh session; a same-tool result may be another call.
      addUserWait(open, {
        ...fields,
        kind: 'unidentified',
        waitKey: `permission:${JSON.stringify([fields.toolName, fields.toolInput])}`
      })
    }
  }
  const kept = boundOpenToolUses(open)
  if (kept.length > 0) {
    state.claudeOpenToolUsesByPaneKey.set(paneKey, kept)
  } else {
    state.claudeOpenToolUsesByPaneKey.delete(paneKey)
  }
  return !toolUseId && asked.length === 1
    ? { ...hookPayload, tool_use_id: asked[0].toolUseId }
    : hookPayload
}

/** True while something still waits on the user: a permission request, question or dialog nobody has settled. */
export function claudeHasRequestAwaitingUser(state: HookListenerState, paneKey: string): boolean {
  return (
    state.claudeOpenToolUsesByPaneKey
      .get(paneKey)
      ?.some((entry) => entry.kind !== 'tool' || entry.awaitingUser) === true
  )
}

// A repeated delivery of the same wait is one wait, which also bounds waits no ordinary result can retire.
function addUserWait(open: ClaudeToolRequest[], wait: ClaudeUserWait): void {
  if (!open.some((entry) => entry.kind === wait.kind && isSameOwnedWait(entry, wait))) {
    open.push(wait)
  }
}

function isSameOwnedWait(entry: ClaudeUserWait, wait: ClaudeUserWait): boolean {
  return (
    entry.waitKey === wait.waitKey &&
    entry.toolAgentId === wait.toolAgentId &&
    entry.toolAgentType === wait.toolAgentType
  )
}

// Evicting a call that waits on the user would read as settled, so the bound drops only calls nobody is asked about.
function boundOpenToolUses(open: ClaudeToolRequest[]): ClaudeToolRequest[] {
  const idle = open.filter((entry) => entry.kind === 'tool' && !entry.awaitingUser)
  if (idle.length <= MAX_OPEN_TOOL_USES) {
    return open
  }
  const evicted = new Set(idle.slice(0, idle.length - MAX_OPEN_TOOL_USES))
  return open.filter((entry) => !evicted.has(entry))
}

function endedRequests(
  eventName: unknown,
  toolUseId: string | undefined,
  toolAgentId: string | undefined,
  hookPayload: Record<string, unknown>
): 'all' | ((entry: ClaudeToolRequest) => boolean) {
  if (
    eventName === 'SessionStart' &&
    toolAgentId === undefined &&
    CLAUDE_NEW_SESSION_START_SOURCES.has(hookPayload.source)
  ) {
    return 'all'
  }
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    return (entry) => isOwnedCall(entry, toolAgentId) && entry.toolUseId === toolUseId
  }
  if (eventName === 'ElicitationResult') {
    const result = { ...readRequestFields(hookPayload), ...elicitationWait(hookPayload) }
    // A result without an id cannot say which dialog it answers, or whether it was delivered twice.
    return (entry) =>
      result.kind === 'elicitation' &&
      entry.kind === 'elicitation' &&
      isSameOwnedWait(entry, result)
  }
  // A stopped subagent can no longer be asked anything.
  if ((eventName === 'SubagentStop' || eventName === 'StopFailure') && toolAgentId !== undefined) {
    return (entry) => entry.toolAgentId === toolAgentId
  }
  if (eventName === 'PostToolBatch') {
    const settled = new Set(readClaudeBatchSettledRequests(hookPayload)?.map((r) => r.toolUseId))
    return (entry) => isOwnedCall(entry, toolAgentId) && settled.has(entry.toolUseId)
  }
  // A lead's calls never outlive its turn; background children's can. An injected task notification is not a turn.
  const leadTurnBoundary =
    toolAgentId === undefined &&
    (eventName === 'Stop' ||
      eventName === 'StopFailure' ||
      (eventName === 'UserPromptSubmit' && isExplicitUserPrompt(hookPayload)))
  return (entry) => leadTurnBoundary && entry.toolAgentId === undefined
}

// A result or batch ends only its own agent's call, so a reused id cannot end another agent's prompt.
function isOwnedCall(
  entry: ClaudeToolRequest,
  toolAgentId: string | undefined
): entry is ClaudeToolCall {
  return entry.kind === 'tool' && entry.toolAgentId === toolAgentId
}

function isExplicitUserPrompt(hookPayload: Record<string, unknown>): boolean {
  const prompt = extractPromptText(hookPayload)
  return hasExplicitUserPrompt('claude', 'UserPromptSubmit', prompt, prompt.text)
}

// Claude pairs a dialog with its result by elicitation_id, which is unique only within its MCP server.
// Without one, the dialog is an unidentified wait for its server: an answered one keeps the pane waiting until a
// boundary, as main does for every dialog.
function elicitationWait(
  hookPayload: Record<string, unknown>
): Pick<ClaudeUserWait, 'kind' | 'waitKey'> {
  const server = readString(hookPayload, 'mcp_server_name') ?? ''
  const id = readString(hookPayload, 'elicitation_id')
  return id
    ? { kind: 'elicitation', waitKey: JSON.stringify([server, id]) }
    : { kind: 'unidentified', waitKey: `elicitation:${server}` }
}
