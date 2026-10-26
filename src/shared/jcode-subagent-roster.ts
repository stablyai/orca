import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { AGENT_SUBAGENT_ID_MAX_LENGTH } from './agent-status-subagent-snapshot'
import {
  normalizeOptionalField,
  normalizeOptionalMultilineField
} from './agent-status-field-normalization'

export type JcodeSubagentRoster = Map<string, TrackedJcodeSubagent>
export type TrackedJcodeSubagent = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'idle'
  startedAt: number
  lastActivityAt: number
  report?: string
  restoredFromSnapshot?: boolean
}

export function upsertJcodeSubagent(
  roster: JcodeSubagentRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    state: 'working' | 'idle'
    report?: string
  },
  now: number
): void {
  const key = id.trim()
  if (!key || key.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const existing = roster.get(key)
  roster.set(key, {
    agentType:
      normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH) ?? existing?.agentType,
    description:
      normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH) ??
      existing?.description,
    model: normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH) ?? existing?.model,
    state: fields.state,
    startedAt: existing?.startedAt ?? now,
    lastActivityAt: now,
    report:
      normalizeOptionalMultilineField(fields.report, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH) ??
      existing?.report
  })
}

export function finishJcodeSubagent(roster: JcodeSubagentRoster, id: string): void {
  roster.delete(id.trim())
}

export function seedJcodeSubagentRoster(
  roster: JcodeSubagentRoster,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (
      roster.has(snapshot.id.trim()) ||
      (snapshot.state !== 'working' && snapshot.state !== 'idle')
    ) {
      continue
    }
    upsertJcodeSubagent(
      roster,
      snapshot.id,
      { ...snapshot, state: snapshot.state, report: snapshot.lastAssistantMessage },
      snapshot.startedAt
    )
    const tracked = roster.get(snapshot.id.trim())
    if (tracked) {
      tracked.restoredFromSnapshot = true
    }
  }
}

export function reapUnconfirmedRestoredJcodeSubagents(roster: JcodeSubagentRoster): boolean {
  let changed = false
  for (const [id, tracked] of roster) {
    if (tracked.restoredFromSnapshot === true) {
      roster.delete(id)
      changed = true
    }
  }
  return changed
}

export function jcodeRosterToSnapshots(
  roster: JcodeSubagentRoster | undefined,
  now = Date.now()
): AgentSubagentSnapshot[] | undefined {
  if (!roster?.size) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    state:
      tracked.state === 'working' && now - tracked.lastActivityAt > AGENT_STATUS_STALE_AFTER_MS
        ? ('unverifiable' as const)
        : tracked.state,
    startedAt: tracked.startedAt,
    ...(tracked.report !== undefined ? { lastAssistantMessage: tracked.report } : {})
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return snapshots
}
