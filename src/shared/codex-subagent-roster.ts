import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'

const CODEX_SUBAGENT_ID_MAX_LENGTH = 64

export type CodexSubagentRoster = Map<string, TrackedCodexSubagent>

type TrackedCodexSubagent = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting'
  startedAt: number
  /** Last moment THIS child's own activity was observed. Separate from
   *  `startedAt`, the spawn stamp the snapshot sort depends on. */
  evidenceObservedAt?: number
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
  now: number,
  /** When this child was observed. Deliberately separate from `now`: two callers
   *  pass a SPAWN stamp there (the transcript scan and the restore seed), and
   *  reusing it would backdate the child's recency to its own birth. Omitted =
   *  nothing was observed, so the clock is left exactly as it was. */
  observedAt?: number
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
    existing.evidenceObservedAt = observedAt ?? existing.evidenceObservedAt
    return
  }
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    state: fields.state,
    startedAt: now,
    ...(observedAt !== undefined ? { evidenceObservedAt: observedAt } : {})
  })
}

export function finishCodexSubagent(roster: CodexSubagentRoster, id: string): void {
  roster.delete(id.trim())
}

/**
 * Record the model a already-tracked child is running. Deliberately narrower
 * than `upsertCodexSubagent`: it never creates a roster entry and never touches
 * `state`, so late model discovery from a child rollout cannot resurrect a
 * finished child nor move any child's lifecycle.
 */
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
      snapshot.startedAt,
      // A restore observes nothing: carry the persisted clock, never invent one.
      snapshot.evidenceObservedAt
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
    startedAt: tracked.startedAt,
    ...(tracked.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: tracked.evidenceObservedAt }
      : {})
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}

export function codexRosterEffectiveState(
  roster: CodexSubagentRoster | undefined,
  leadState: 'working' | 'waiting' | 'done'
): 'working' | 'waiting' | 'done' {
  if (!roster || roster.size === 0) {
    return leadState
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'waiting') {
      return 'waiting'
    }
  }
  return leadState === 'done' ? 'working' : leadState
}
