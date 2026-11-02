import { createHash } from 'node:crypto'
import { isRecord } from '../agent-status-child-work-value-guards'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { ParsedAgentStatusPayload } from '../agent-status-types'
import {
  MAX_CLAUDE_SETTLED_REQUESTS,
  type ClaudeSettledRequest
} from './claude-settled-permission-requests'
import type { HookListenerState } from './listener-state'
import { buildClaudeCachedLeadStatusPayload } from './providers/claude-lifecycle-events'
import { setClaudeMainAgentTurnState } from './providers/claude-roster-state'
import { readString } from './tool-input-preview'

/** Calls whose PreToolUse was seen and whose own settlement was not, by owner ('' is the root agent). */
export type ClaudeInFlightCalls = {
  launchToken?: string
  session?: string
  owners: Map<string, Map<string, string>>
  size: number
  /** Owners with a call not recorded (past the bound, or input unreadable); their requests stay unbound until they end. */
  lossy: Set<string>
  /** The pane's latest ordinary request, when it is bound; only its own settlement can end it. */
  bound?: { owner: string; toolUseId: string }
}

// Why a bound: a call can lose its settlement (crash, dropped hook); past it, a missed equal input could bind wrongly.
const MAX_IN_FLIGHT_CALLS = 256

export type ClaudePermissionBinding = {
  /** The hook with the provider's missing tool_use_id filled from the one in-flight call it can be. */
  hookPayload?: Record<string, unknown>
  /** A batch that settles the bound request, or one a cold host cannot judge; the receiver decides. */
  settled?: ClaudeSettledRequest[]
  /** The batch's row, built only once the provider normalizer produced none of its own. */
  settlementPayload?: () => ParsedAgentStatusPayload | null
}

/** Whole tool name and input, object keys ordered; only the digest is kept. */
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

export function retireClaudeInFlightCalls(
  state: HookListenerState,
  paneKey: string,
  owns: (owner: string) => boolean
): void {
  const table = state.claudeInFlightByPaneKey.get(paneKey)
  if (!table) {
    return
  }
  for (const [owner, calls] of table.owners) {
    if (owns(owner)) {
      table.size -= calls.size
      table.owners.delete(owner)
      table.lossy.delete(owner)
    }
  }
  if (table.bound && owns(table.bound.owner)) {
    table.bound = undefined
  }
}

function settle(table: ClaudeInFlightCalls, owner: string, toolUseId: string): boolean {
  const calls = table.owners.get(owner)
  if (calls?.delete(toolUseId)) {
    table.size -= 1
  }
  const released = table.bound?.owner === owner && table.bound.toolUseId === toolUseId
  if (released) {
    table.bound = undefined
  }
  return released
}

/** Observe one Claude hook before normalization; binds an id-less request to its single in-flight call. */
export function observeClaudePermissionBinding(
  state: HookListenerState,
  paneKey: string,
  launchToken: string | undefined,
  event: unknown,
  raw: Record<string, unknown>
): ClaudePermissionBinding {
  const owner = readString(raw, 'agent_id') ?? ''
  const session = readString(raw, 'session_id')
  let table = state.claudeInFlightByPaneKey.get(paneKey)
  const cold = !table
  if (
    !table ||
    table.launchToken !== launchToken ||
    (owner === '' &&
      (event === 'SessionStart' ||
        event === 'SessionEnd' ||
        (session !== undefined && table.session !== undefined && session !== table.session)))
  ) {
    table = { launchToken, owners: new Map(), size: 0, lossy: new Set() }
    state.claudeInFlightByPaneKey.set(paneKey, table)
  }
  if (owner === '' && session) {
    table.session = session
  }
  if (
    owner === ''
      ? event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure'
      : event === 'SubagentStop'
  ) {
    retireClaudeInFlightCalls(state, paneKey, (ended) => ended === owner)
  }
  const toolUseId = readString(raw, 'tool_use_id')
  const toolName = readString(raw, 'tool_name')
  if (event === 'PreToolUse' && toolUseId) {
    const key = digest(toolName, raw.tool_input)
    const calls = table.owners.get(owner) ?? new Map<string, string>()
    table.owners.set(owner, calls)
    if (!key || (!calls.has(toolUseId) && table.size >= MAX_IN_FLIGHT_CALLS)) {
      table.lossy.add(owner)
    } else if (!calls.has(toolUseId)) {
      calls.set(toolUseId, key)
      table.size += 1
    }
    return {}
  }
  if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && toolUseId) {
    settle(table, owner, toolUseId)
    return {}
  }
  if (event === 'PostToolBatch') {
    const ids = (Array.isArray(raw.tool_calls) ? raw.tool_calls : []).flatMap((call: unknown) => {
      const id = isRecord(call) ? readString(call, 'tool_use_id') : undefined
      return id ? [id] : []
    })
    const released = ids.filter((id) => settle(table, owner, id))
    if (!released.length && !cold) {
      return {}
    }
    const agentType = readString(raw, 'agent_type')
    const settled = (released.length ? released : ids)
      .slice(0, MAX_CLAUDE_SETTLED_REQUESTS)
      .map((id) => ({
        toolUseId: id,
        ...(owner ? { toolAgentId: owner } : {}),
        ...(agentType ? { toolAgentType: agentType } : {})
      }))
    return settled.length
      ? {
          settled,
          settlementPayload: () =>
            buildClaudeSettlementPayload(state, paneKey, raw, released.length > 0)
        }
      : {}
  }
  if (event === 'PermissionRequest' && !isAskUserQuestionTool(toolName)) {
    const key = toolUseId ? undefined : digest(toolName, raw.tool_input)
    const candidates =
      key && !table.lossy.has(owner)
        ? [...(table.owners.get(owner) ?? [])].filter(([, input]) => input === key)
        : []
    // E+: exactly one equal in-flight call names the request; zero or several keep main's unbound path.
    const bound = toolUseId ?? (candidates.length === 1 ? candidates[0][0] : undefined)
    table.bound = bound ? { owner, toolUseId: bound } : undefined
    return bound && !toolUseId ? { hookPayload: { ...raw, tool_use_id: bound } } : {}
  }
  return {}
}

/** A batch carrying settlement: resume the lead its bound request displaced, then report the cached state. */
function buildClaudeSettlementPayload(
  state: HookListenerState,
  paneKey: string,
  raw: Record<string, unknown>,
  release: boolean
): ParsedAgentStatusPayload | null {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  // As the request's own completion would: a root wait resumes working, a child wait restores what it displaced.
  if (release && lead?.state === 'waiting' && lead.waitingAgentId === readString(raw, 'agent_id')) {
    setClaudeMainAgentTurnState(
      state,
      paneKey,
      lead.waitingAgentId
        ? (lead.stateBeforeWait ?? { state: 'working' })
        : { state: 'working', ...(lead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {}) }
    )
  }
  // A batch fires mid-turn once its calls resolve, so even a cold host can report the turn working.
  return buildClaudeCachedLeadStatusPayload(state, 'PostToolBatch', paneKey, raw, {
    inTurnEvidence: true
  })
}
