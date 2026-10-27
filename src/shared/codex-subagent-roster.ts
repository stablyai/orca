import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'
import { readCodexSubagentIdentity } from './codex-subagent-identity'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'

const CODEX_SUBAGENT_ID_MAX_LENGTH = 64

export type CodexSubagentRoster = Map<string, TrackedCodexSubagent>

type TrackedCodexSubagent = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting'
  startedAt: number
  identityTranscriptPath?: string
}

export function upsertCodexSubagent(
  roster: CodexSubagentRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    state: 'working' | 'waiting'
  },
  now: number
): void {
  const normalizedId = id.trim()
  if (normalizedId.length === 0 || normalizedId.length > CODEX_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const agentType = normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH)
  const description = normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const model = normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH)
  const existing = roster.get(normalizedId)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    existing.description = description ?? existing.description
    existing.model = model ?? existing.model
    existing.state = fields.state
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    state: fields.state,
    startedAt: now
  })
}

export function finishCodexSubagent(roster: CodexSubagentRoster, id: string): void {
  roster.delete(id.trim())
}

export function enrichCodexSubagentIdentity(
  roster: CodexSubagentRoster,
  id: string,
  transcriptPath: string | undefined
): void {
  const child = roster.get(id.trim())
  if (!child || !transcriptPath || child.identityTranscriptPath === transcriptPath) {
    return
  }
  const identity = readCodexSubagentIdentity(transcriptPath, id.trim())
  if (!identity) {
    return
  }
  child.identityTranscriptPath = transcriptPath
  child.description =
    normalizeOptionalField(identity.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH) ??
    child.description
}

/** Update only an existing child’s model, preserving lifecycle so late discovery cannot resurrect finished children. */
export function setCodexSubagentModel(
  roster: CodexSubagentRoster,
  id: string,
  model: string | undefined
): void {
  const normalizedModel = normalizeOptionalField(model, AGENT_MODEL_MAX_LENGTH)
  if (!normalizedModel) {
    return
  }
  const existing = roster.get(id.trim())
  if (!existing) {
    return
  }
  existing.model = normalizedModel
}

export function seedCodexSubagentRoster(
  roster: CodexSubagentRoster,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'working' && snapshot.state !== 'waiting') {
      continue
    }
    upsertCodexSubagent(
      roster,
      snapshot.id,
      {
        agentType: snapshot.agentType,
        description: snapshot.description,
        model: snapshot.model,
        state: snapshot.state
      },
      snapshot.startedAt
    )
  }
}

export function codexRosterToSnapshots(
  roster: CodexSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}

/** Project spawned agent threads through the shared kind policy: waiting/working child evidence, never watch loops. */
export function codexRosterChildWorkLiveness(
  roster: CodexSubagentRoster | undefined
): AgentChildWorkLiveness {
  return agentChildWorkLiveness(
    roster
      ? Array.from(roster.values(), (tracked) => ({ kind: 'agent' as const, state: tracked.state }))
      : undefined
  )
}
