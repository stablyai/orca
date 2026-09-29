// A pane's in-process subagents as the hook lane publishes them on a status row: the snapshot
// shape, its normalization at every admission point, and the equality stores reuse arrays by.

import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeOptionalField
} from './agent-status-field-normalization'

export type AgentSubagentState = 'working' | 'blocked' | 'waiting' | 'idle' | 'unverifiable'

/** A live in-process child of the pane's provider session. Rendered as an
 *  indented child row with no PTY of its own. */
export type AgentSubagentSnapshot = {
  /** Provider-assigned lifecycle id. */
  id: string
  agentType?: string
  /** Provider model used by this child, when exposed by its lifecycle event. */
  model?: string
  description?: string
  state: AgentSubagentState
  /** Timestamp (ms) when this subagent was first observed. */
  startedAt: number
}

/** Maximum subagent child rows carried per status entry. Bounds per-pane cache
 *  and IPC fanout against a runaway spawner. */
export const AGENT_STATUS_MAX_SUBAGENTS = 32
const AGENT_SUBAGENT_ID_MAX_LENGTH = 64

function normalizeSubagentSnapshot(value: unknown): AgentSubagentSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string') {
    return null
  }
  const id = obj.id.trim()
  if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return null
  }
  if (
    obj.state !== 'working' &&
    obj.state !== 'blocked' &&
    obj.state !== 'waiting' &&
    obj.state !== 'idle' &&
    obj.state !== 'unverifiable'
  ) {
    return null
  }
  return {
    id,
    state: obj.state,
    startedAt:
      typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
    description: normalizeOptionalField(obj.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  }
}

export function normalizeAgentSubagentsField(value: unknown): AgentSubagentSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  const normalized: AgentSubagentSnapshot[] = []
  for (const item of value) {
    const snapshot = normalizeSubagentSnapshot(item)
    if (snapshot) {
      normalized.push(snapshot)
      if (normalized.length >= AGENT_STATUS_MAX_SUBAGENTS) {
        break
      }
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

/** Structural equality for subagent lists so stores can reuse the previous
 *  array reference (and skip fanout) when nothing actually changed. */
export function agentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a && !b
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.startedAt !== y.startedAt ||
      x.agentType !== y.agentType ||
      x.model !== y.model ||
      x.description !== y.description
    ) {
      return false
    }
  }
  return true
}
