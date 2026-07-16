import {
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'

const AGENT_SUBAGENT_ID_MAX_LENGTH = 64

export type AgentSubagentRoster = Map<string, TrackedAgentSubagent>

type TrackedAgentSubagent = {
  agentType?: string
  description?: string
  startedAt: number
}

export function upsertWorkingSubagent(
  roster: AgentSubagentRoster,
  id: string,
  fields: { agentType?: string; description?: string },
  now: number
): boolean {
  if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return false
  }
  const normalizedFields = {
    agentType: normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH),
    description: normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  }
  const existing = roster.get(id)
  if (existing) {
    existing.agentType = normalizedFields.agentType ?? existing.agentType
    existing.description = normalizedFields.description ?? existing.description
    return true
  }
  // Why: entries beyond the wire cap could gate the parent while remaining
  // invisible in the sidebar, so reject them instead of tracking hidden work.
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return false
  }
  roster.set(id, { ...normalizedFields, startedAt: now })
  return true
}

export function finishSubagent(roster: AgentSubagentRoster, id: string): void {
  roster.delete(id)
}

export function rosterHasWorkingSubagent(roster: AgentSubagentRoster | undefined): boolean {
  return roster !== undefined && roster.size > 0
}

export function agentSubagentRosterToSnapshots(
  roster: AgentSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    state: 'working' as const,
    startedAt: tracked.startedAt,
    agentType: tracked.agentType,
    description: tracked.description
  }))
  // Why: concurrent child hooks have no stable arrival order; deterministic
  // snapshots let the store reuse an unchanged roster instead of re-rendering.
  snapshots.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return snapshots
}
