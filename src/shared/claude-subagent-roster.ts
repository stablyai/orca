import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'

/** Mirrors the wire-normalization id cap in agent-status-types. Enforced at
 *  upsert so an over-long id can't gate the pane 'working' while being
 *  invisible in the emitted snapshots (which drop such ids). */
const CLAUDE_SUBAGENT_ID_MAX_LENGTH = 64

/** Live subagents/teammates tracked for one Claude pane, keyed by the
 *  provider-assigned `agent_id` from SubagentStart/SubagentStop payloads. */
export type ClaudeSubagentRoster = Map<string, TrackedClaudeSubagent>

export type TrackedClaudeSubagent = {
  agentType?: string
  description?: string
  state: 'working' | 'idle'
  startedAt: number
  /** The id came from background_tasks or a persisted snapshot, not live
   *  lifecycle events, so a PRESENT list omitting it proves the task is gone
   *  (a phantom seeded before restart would otherwise gate the pane 'working'
   *  forever — teams sessions never send an empty list). Cleared once live
   *  activity re-tracks the id, so a seeded-but-alive teammate is demoted at
   *  most until its next tool event. */
  backgroundTasksAuthoritative?: boolean
}

/** One agent entry from the `background_tasks` array Claude attaches to Stop
 *  (and SubagentStop) hook payloads. Non-agent task types (background shells,
 *  crons) are filtered out at read time. */
export type ClaudeBackgroundAgentTask = {
  id: string
  agentType?: string
  description?: string
  running: boolean
  /** True for `type: "teammate"` entries, whose ids never match lifecycle
   *  agent_ids and whose "running" status persists while idle. */
  teammate: boolean
}

export function upsertWorkingClaudeSubagent(
  roster: ClaudeSubagentRoster,
  id: string,
  fields: { agentType?: string; description?: string },
  now: number
): void {
  if (id.length === 0 || id.length > CLAUDE_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const existing = roster.get(id)
  if (existing) {
    existing.state = 'working'
    existing.agentType = fields.agentType ?? existing.agentType
    existing.description = fields.description ?? existing.description
    // Why: live activity proves the lifecycle stream owns this id again;
    // background_tasks absence must stop demoting it (teammate ids never
    // appear there). The fold re-tags its own recreations after this call.
    existing.backgroundTasksAuthoritative = undefined
    return
  }
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS && !evictOldestIdleClaudeSubagent(roster)) {
    return
  }
  roster.set(id, {
    state: 'working',
    startedAt: now,
    agentType: fields.agentType,
    description: fields.description
  })
}

function evictOldestIdleClaudeSubagent(roster: ClaudeSubagentRoster): boolean {
  let oldestId: string | null = null
  let oldestStartedAt = Infinity
  for (const [id, tracked] of roster) {
    if (tracked.state === 'idle' && tracked.startedAt < oldestStartedAt) {
      oldestId = id
      oldestStartedAt = tracked.startedAt
    }
  }
  if (oldestId === null) {
    return false
  }
  roster.delete(oldestId)
  return true
}

export function markClaudeSubagentIdle(roster: ClaudeSubagentRoster, id: string): void {
  const existing = roster.get(id)
  if (existing) {
    existing.state = 'idle'
  }
}

/** Read the agent-typed entries of a hook payload's `background_tasks` field.
 *  `present: false` means the field was absent/malformed (older Claude builds),
 *  so callers must keep their tracked roster instead of clearing it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return { present: false, tasks: [] }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const obj = item as Record<string, unknown>
    if (obj.type !== 'subagent' && obj.type !== 'teammate') {
      continue
    }
    if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
      continue
    }
    tasks.push({
      id: obj.id,
      agentType: typeof obj.agent_type === 'string' ? obj.agent_type : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      running: obj.status === 'running',
      teammate: obj.type === 'teammate'
    })
    if (tasks.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      break
    }
  }
  return { present: true, tasks }
}

/** Fold a lead Stop's `background_tasks` into the lifecycle-tracked roster.
 *
 *  Why this is NOT a replace: teammate entries report `status: "running"`
 *  while the teammate is alive but idle, and their task ids never match the
 *  `agent_id` used by SubagentStart/SubagentStop — so the list cannot decide
 *  teammate working-ness or map onto lifecycle-tracked children. Only the
 *  unambiguous signals are taken:
 *  - an empty list proves nothing is left alive → clear the roster;
 *  - an id-exact match (one-shot background subagents reuse `agent_id` as the
 *    task id) is trusted fully — description enrichment and run state;
 *  - an unmatched RUNNING non-teammate entry is a one-shot subagent this
 *    listener never saw start (Orca/relay restart mid-run) → recreate it so
 *    the pane doesn't read done while the child still runs;
 *  - a roster entry whose id is KNOWN to be a task id
 *    (backgroundTasksAuthoritative) but is missing from the present list is
 *    finished → demote it to idle. */
export function foldClaudeBackgroundTasksIntoRoster(
  roster: ClaudeSubagentRoster,
  tasks: ClaudeBackgroundAgentTask[],
  now: number
): void {
  if (tasks.length === 0) {
    roster.clear()
    return
  }
  const listedIds = new Set<string>()
  for (const task of tasks) {
    listedIds.add(task.id)
    const existing = roster.get(task.id)
    if (existing) {
      existing.state = task.running ? 'working' : 'idle'
      existing.agentType = task.agentType ?? existing.agentType
      existing.description = task.description ?? existing.description
      continue
    }
    if (task.teammate || !task.running) {
      continue
    }
    upsertWorkingClaudeSubagent(
      roster,
      task.id,
      { agentType: task.agentType, description: task.description },
      now
    )
    const created = roster.get(task.id)
    if (created) {
      created.backgroundTasksAuthoritative = true
    }
  }
  for (const [id, tracked] of roster) {
    if (tracked.backgroundTasksAuthoritative && tracked.state === 'working' && !listedIds.has(id)) {
      tracked.state = 'idle'
    }
  }
}

/** Whether a lifecycle agent id belongs to the named teammate. Teammate ids
 *  embed the name as `a<name>-<hex>`; requiring a hyphen-free suffix keeps
 *  teammate "rev" from matching "rev-two"'s ids (`arev-two-<hex>`), while a
 *  hyphenated name still matches its own ids exactly. */
export function claudeTeammateIdMatchesName(id: string, name: string): boolean {
  const prefix = `a${name}-`
  return id.startsWith(prefix) && !id.slice(prefix.length).includes('-')
}

/** Mark a teammate idle from a TeammateIdle hook, which is keyed by name.
 *  Named teammates embed their name in `agent_id` (`a<name>-<hex>`); prefer
 *  that exact signal. Fall back to `agent_type === name` only when no id
 *  matches, so a one-shot subagent whose agent_type happens to collide with a
 *  teammate's name isn't wrongly idled alongside it. */
export function markClaudeTeammateIdleByName(roster: ClaudeSubagentRoster, name: string): boolean {
  let matchedById = false
  let changed = false
  for (const [id, tracked] of roster) {
    if (!claudeTeammateIdMatchesName(id, name)) {
      continue
    }
    matchedById = true
    if (tracked.state !== 'idle') {
      tracked.state = 'idle'
      changed = true
    }
  }
  if (matchedById) {
    return changed
  }
  for (const tracked of roster.values()) {
    if (tracked.agentType === name && tracked.state !== 'idle') {
      tracked.state = 'idle'
      changed = true
    }
  }
  return changed
}

export function claudeRosterHasWorkingSubagent(roster: ClaudeSubagentRoster | undefined): boolean {
  if (!roster) {
    return false
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'working') {
      return true
    }
  }
  return false
}

export function claudeRosterToSnapshots(
  roster: ClaudeSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots: AgentSubagentSnapshot[] = []
  for (const [id, tracked] of roster) {
    snapshots.push({
      id,
      state: tracked.state,
      startedAt: tracked.startedAt,
      agentType: tracked.agentType,
      description: tracked.description
    })
  }
  // Why: hook arrival order is not stable across reconciles; sort so equal
  // rosters serialize identically and downstream equality checks can dedupe.
  snapshots.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return snapshots
}
