import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentStatusState,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'

/** Live descendants (subagents, spawned threads, async child runs) of one pane's
 *  lead agent session, keyed by the provider-assigned child id.
 *
 *  Provider-agnostic on purpose: the pane rule "idle only when the lead is idle
 *  AND no descendant is live" is one concept, so it has one implementation. A
 *  provider contributes only how to READ a child out of its hook events
 *  (`agent-hook-listener/descendant-events.ts`). Claude keeps its own roster
 *  because its children carry provider-specific reconciliation (teammate
 *  parking, `background_tasks` folding, restored-snapshot provenance) that no
 *  other provider has; it implements the same pane rule in
 *  `providers/claude-roster-state.ts`. */

const AGENT_DESCENDANT_ID_MAX_LENGTH = 64

export type AgentDescendantRoster = Map<string, TrackedAgentDescendant>

type TrackedAgentDescendant = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting'
  startedAt: number
  /** When this child was last named by one of its provider's events. The reaper's clock:
   *  a roster entry can only ever hold a pane 'working', so a claim nothing can retract
   *  is strictly worse than settling late. */
  lastEventAt: number
}

/** How long a descendant may go unmentioned before the pane stops believing in it.
 *
 *  Every provider loses a child's finish sometimes — the hook was disabled, untrusted or
 *  timed out, the process was killed, the turn was interrupted before its stop gate ran.
 *  Without a ceiling that pane is pinned 'working' for the life of the process, and only
 *  closing it recovers. Deliberately generous: a wrongly reaped child merely settles the
 *  pane early, which the lead's next event corrects, while too short a window would
 *  reintroduce the very bug this roster exists to fix. */
export const AGENT_DESCENDANT_QUIET_REAP_MS = 30 * 60_000

export function upsertAgentDescendant(
  roster: AgentDescendantRoster,
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
  if (normalizedId.length === 0 || normalizedId.length > AGENT_DESCENDANT_ID_MAX_LENGTH) {
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
    existing.lastEventAt = now
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
    lastEventAt: now
  })
}

/** Replace the roster with the provider's authoritative live set. For a provider whose
 *  transport can drop an intermediate message this is the only safe shape: the newest
 *  message is complete, so it repairs every add and removal lost before it. */
export function replaceAgentDescendants(
  roster: AgentDescendantRoster,
  children: readonly {
    id: string
    agentType?: string
    description?: string
    model?: string
  }[],
  now: number
): void {
  const live = new Set<string>()
  for (const child of children) {
    const normalizedId = child.id.trim()
    if (normalizedId.length === 0 || normalizedId.length > AGENT_DESCENDANT_ID_MAX_LENGTH) {
      continue
    }
    live.add(normalizedId)
    upsertAgentDescendant(roster, normalizedId, { ...child, state: 'working' }, now)
  }
  for (const id of Array.from(roster.keys())) {
    if (!live.has(id)) {
      roster.delete(id)
    }
  }
}

/** Drop descendants no event has named for {@link AGENT_DESCENDANT_QUIET_REAP_MS}.
 *  Runs on read rather than on a timer so the roster stays passive. */
export function pruneStaleAgentDescendants(roster: AgentDescendantRoster, now: number): boolean {
  let changed = false
  for (const [id, tracked] of Array.from(roster.entries())) {
    if (now - tracked.lastEventAt > AGENT_DESCENDANT_QUIET_REAP_MS) {
      roster.delete(id)
      changed = true
    }
  }
  return changed
}

export function finishAgentDescendant(roster: AgentDescendantRoster, id: string): void {
  roster.delete(id.trim())
}

/**
 * Record the model a already-tracked child is running. Deliberately narrower
 * than `upsertAgentDescendant`: it never creates a roster entry and never touches
 * `state`, so late model discovery from a child rollout cannot resurrect a
 * finished child nor move any child's lifecycle.
 */
export function setAgentDescendantModel(
  roster: AgentDescendantRoster,
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

export function seedAgentDescendantRoster(
  roster: AgentDescendantRoster,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'working' && snapshot.state !== 'waiting') {
      continue
    }
    upsertAgentDescendant(
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
    // Why: a restored child's quiet clock starts at its own start time, so a seed whose
    // finish was lost while Orca was down cannot outlive the reap window a live one gets.
    const restored = roster.get(snapshot.id.trim())
    if (restored) {
      restored.lastEventAt = snapshot.startedAt
    }
  }
}

export function agentDescendantRosterToSnapshots(
  roster: AgentDescendantRoster | undefined
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

/** The pane's state once its live descendants are taken into account: a lead
 *  `done` is only the pane's `done` when nothing is still running under it. A
 *  descendant blocked on a human answer outranks the lead's own working state,
 *  since that wait is the actionable one. */
export function agentDescendantEffectiveState(
  roster: AgentDescendantRoster | undefined,
  leadState: AgentStatusState
): AgentStatusState {
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
