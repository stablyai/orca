import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { ParsedAgentStatusPayload } from '../shared/agent-status-types'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type {
  ClaudePermissionProjection,
  ClaudeProjectedRow
} from '../shared/agent-hook-listener/claude-permission-facts'
import {
  attachClaudePermissionToolUseId,
  claudeBatchSettlesRequest,
  resumeClaudeRequestLead,
  holdClaudeRequest,
  shouldKeepClaudePermissionVisible
} from '../shared/agent-hook-listener/claude-permission-transition'
import { withoutClaudeBatch } from '../shared/agent-hook-listener/claude-permission-host-rules'

export type RelayClaudePermissionDecision =
  /** Cache and forward this row (with the host's projection when the host knows the pane's dialog). */
  | { kind: 'publish'; event: AgentHookEventPayload }
  /** Forward the current canonical row again without caching anything new. */
  | { kind: 'republish'; event: AgentHookEventPayload }
  /** A batch that ends nothing this host represents: main's no-op. */
  | { kind: 'none' }

const PROJECTED: ClaudePermissionProjection = { version: 1 }

function isOrdinaryRequest(event: AgentHookEventPayload): boolean {
  return (
    event.payload.agentType === 'claude' &&
    event.payload.state === 'waiting' &&
    event.hookEventName === 'PermissionRequest' &&
    event.claudeRequest !== undefined
  )
}

/** What lets a host speak for the pane's dialog: a turn or session boundary, or the dialog itself. */
function observesCurrentDialog(event: AgentHookEventPayload): boolean {
  return (
    event.payload.state === 'waiting' ||
    (!event.toolAgentId &&
      (event.hookEventName === 'UserPromptSubmit' || event.hookEventName === 'SessionStart'))
  )
}

/**
 * The relay's own permission transition, the one its desktop would otherwise repeat on forwarded rows.
 * `cached` is the relay's latest row; the represented request, when held, is the canonical one.
 */
export function decideRelayClaudePermission(
  state: HookListenerState,
  cached: AgentHookEventPayload | undefined,
  event: AgentHookEventPayload,
  isReplay: boolean
): RelayClaudePermissionDecision {
  if (event.source !== 'claude') {
    return { kind: 'publish', event }
  }
  const requests = state.claudePermissionRequestByPaneKey
  const known = requests.has(event.paneKey)
  const represented = requests.get(event.paneKey) ?? undefined
  if (event.claudeBatch) {
    if (!isReplay && represented && claudeBatchSettlesRequest(represented, event)) {
      requests.set(event.paneKey, null)
      // The batch's calls end with this decision; nothing cached may replay them as another batch.
      return {
        kind: 'publish',
        event: {
          ...withoutClaudeBatch(resumeClaudeRequestLead(state, represented, event)),
          claudePermission: PROJECTED
        }
      }
    }
    // Nothing held: show the current dialog again, so a receiver that missed it catches up.
    return !isReplay && known && !represented && cached
      ? { kind: 'republish', event: { ...cached, claudePermission: PROJECTED } }
      : { kind: 'none' }
  }
  const attached = attachClaudePermissionToolUseId(represented ?? cached, event)
  if (represented && shouldKeepClaudePermissionVisible(represented, attached, state)) {
    const held = holdClaudeRequest(represented, attached, true)
    requests.set(event.paneKey, held)
    // Each publication carries the request itself: a coalesced retry may be the only one delivered.
    return {
      kind: 'publish',
      event: {
        ...event,
        claudePermission: { version: 1, held: true, row: projectedRequestRow(held, held.payload) }
      }
    }
  }
  if (!known && !observesCurrentDialog(event)) {
    // A cold host has not seen this pane's dialog: it must not overrule a receiver that has.
    return { kind: 'publish', event }
  }
  requests.set(event.paneKey, isOrdinaryRequest(attached) ? attached : null)
  return { kind: 'publish', event: { ...event, claudePermission: PROJECTED } }
}

/** The projection a reconnect replay carries: the held request itself, for a receiver that missed it. */
export function relayClaudeReplayProjection(
  state: HookListenerState,
  paneKey: string
): ClaudePermissionProjection | undefined {
  if (!state.claudePermissionRequestByPaneKey.has(paneKey)) {
    return undefined
  }
  const request = state.claudePermissionRequestByPaneKey.get(paneKey)
  if (!request) {
    return PROJECTED
  }
  return {
    version: 1,
    held: true,
    row: projectedRequestRow(
      request,
      currentRoster(request.payload, state.lastStatusByPaneKey.get(paneKey)?.payload)
    )
  }
}

/** The represented request as a projected row: its own identity, with `payload` as its current view. */
function projectedRequestRow(
  request: AgentHookEventPayload,
  payload: ParsedAgentStatusPayload
): ClaudeProjectedRow {
  const toolUseId = request.claudeRequest?.providerToolUseId
  return {
    hookEventName: request.hookEventName ?? 'PermissionRequest',
    // A host-inherited id is the legacy guess, never published as the request's own.
    ...(toolUseId ? { toolUseId } : {}),
    ...(request.toolAgentId ? { toolAgentId: request.toolAgentId } : {}),
    ...(request.toolAgentType ? { toolAgentType: request.toolAgentType } : {}),
    payload
  }
}

/** The held request's own card with the pane's current roster, so both views name one roster. */
function currentRoster(
  request: ParsedAgentStatusPayload,
  current: ParsedAgentStatusPayload | undefined
): ParsedAgentStatusPayload {
  const { subagents: _held, ...card } = request
  return current?.subagents ? { ...card, subagents: current.subagents } : card
}
