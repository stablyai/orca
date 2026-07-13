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
  /** Known agent-teams teammate: its id embeds its name (`a<name>-<hex>`)
   *  while one-shot ids are hyphen-free (`a<hex>`). Teammates are long-lived —
   *  SubagentStop means "finished a task", not "gone" — and their lifecycle
   *  ids never appear in background_tasks, so omission proves nothing. */
  teammate?: true
  /** The id came from a persisted snapshot or background_tasks, not live
   *  lifecycle events. Only matters for teammate-shaped seeds now: a PRESENT
   *  list omitting a seeded-working teammate demotes it to idle so a phantom
   *  seeded before restart can't gate the pane 'working' forever (teams
   *  sessions never send an empty list). Cleared once live activity re-tracks
   *  the id. Non-teammate entries omitted from a present list are removed
   *  outright regardless of this flag. */
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

/** Agent-team lifecycle ids are `a<teammate-name>-<hex>`. The teammate name
 *  and agent type are independent spawn fields, so the id shape is the only
 *  reliable discriminator available on SubagentStart/SubagentStop hooks. */
export function isClaudeTeammateLifecycleId(id: string): boolean {
  const separator = id.lastIndexOf('-')
  return separator > 1 && id.startsWith('a') && /^[0-9a-f]+$/i.test(id.slice(separator + 1))
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
  const teammate = isClaudeTeammateLifecycleId(id)
  const existing = roster.get(id)
  if (existing) {
    existing.state = 'working'
    existing.agentType = fields.agentType ?? existing.agentType
    existing.description = fields.description ?? existing.description
    if (teammate) {
      existing.teammate = true
    }
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
    description: fields.description,
    ...(teammate ? { teammate: true as const } : {})
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

/** SubagentStop: a finished one-shot subagent leaves the sidebar immediately —
 *  retaining it as an idle row made long workflow/ultracode sessions pile up
 *  dozens of dead rows. Teammates only idle (alive + resumable): SubagentStop
 *  fires each time a teammate finishes a task, not just at shutdown.
 *
 *  Workflow/named one-shots share the teammate id shape (`a<label>-<hex>`),
 *  but unlike real teammates they ARE listed id-exact as `type: "subagent"`
 *  background tasks — including inside their own SubagentStop payload
 *  (verified against live hook captures). `listedAsSubagentTask` carries that
 *  corroboration so a finished workflow lane is removed instead of squatting
 *  as a phantom idle teammate. */
export function finishClaudeSubagent(
  roster: ClaudeSubagentRoster,
  id: string,
  options?: { listedAsSubagentTask?: boolean }
): void {
  const existing = roster.get(id)
  if (!existing) {
    return
  }
  if (existing.teammate && options?.listedAsSubagentTask !== true) {
    existing.state = 'idle'
    return
  }
  roster.delete(id)
}

/** Read the agent-typed entries of a hook payload's `background_tasks` field.
 *  `present: false` means the field was absent/malformed (older Claude builds),
 *  so callers must keep their tracked roster instead of clearing it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
  truncated: boolean
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return { present: false, tasks: [], truncated: false }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  let truncated = false
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
    if (tasks.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      // Why: a capped inventory cannot prove a tracked id is absent; callers
      // must retain unlisted rows rather than deleting live overflow tasks.
      truncated = true
      break
    }
    tasks.push({
      id: obj.id,
      agentType: typeof obj.agent_type === 'string' ? obj.agent_type : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      running: obj.status === 'running',
      teammate: obj.type === 'teammate'
    })
  }
  return { present: true, tasks, truncated }
}

/** Fold a lead Stop's `background_tasks` into the lifecycle-tracked roster.
 *
 *  The list is authoritative for non-teammate children: a running one-shot is
 *  always listed under its lifecycle `agent_id` (verified against live hook
 *  captures), foreground children cannot span a lead Stop, and finished tasks
 *  are dropped from the list entirely. So:
 *  - an empty list proves nothing is left alive → clear the roster;
 *  - an id-exact match that is running is trusted fully (state + enrichment);
 *    one reported not running is finished → remove it;
 *  - an unmatched RUNNING non-teammate entry is a one-shot subagent this
 *    listener never saw start (Orca/relay restart mid-run) → recreate it so
 *    the pane doesn't read done while the child still runs;
 *  - a non-teammate roster entry missing from the present list is finished or
 *    dead (its SubagentStop was killed/lost) → remove it, otherwise it pins
 *    the pane 'working' forever;
 *  - teammates are exempt: their task ids never match lifecycle agent_ids, so
 *    omission proves nothing — except a snapshot-seeded phantom
 *    (backgroundTasksAuthoritative), which demotes to idle so it cannot gate
 *    the pane while teams sessions never send an empty list;
 *  - teammate-SHAPED entries are reclassified as one-shots when a subagent-
 *    typed task lists their lifecycle id, and are removed on omission when a
 *    complete inventory lists no teammate-typed task at all (a teams session
 *    always lists its teammates, even idle ones) — workflow/named one-shot
 *    lanes share the id shape and must not squat as phantom teammates. */
export function foldClaudeBackgroundTasksIntoRoster(
  roster: ClaudeSubagentRoster,
  tasks: ClaudeBackgroundAgentTask[],
  now: number,
  options?: { inventoryComplete?: boolean }
): void {
  if (tasks.length === 0) {
    if (options?.inventoryComplete !== false) {
      roster.clear()
    }
    return
  }
  const listedIds = new Set<string>()
  const hasTeammateTypedTask = tasks.some((task) => task.teammate)
  for (const task of tasks) {
    listedIds.add(task.id)
    const existing = roster.get(task.id)
    if (existing) {
      if (!task.running) {
        roster.delete(task.id)
        continue
      }
      existing.state = 'working'
      existing.agentType = task.agentType ?? existing.agentType
      existing.description = task.description ?? existing.description
      // Why: real teammate lifecycle ids never appear as task ids, so an
      // id-exact subagent-typed listing proves this teammate-SHAPED entry is
      // a workflow/named one-shot; unflag it so its stop/omission removes it.
      if (!task.teammate) {
        existing.teammate = undefined
      }
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
  if (options?.inventoryComplete === false) {
    return
  }
  for (const [id, tracked] of roster) {
    if (listedIds.has(id)) {
      continue
    }
    if (tracked.teammate) {
      // Why: a teams session lists its teammates as teammate-typed tasks even
      // while they idle. A complete inventory with NONE proves no teammate is
      // alive — so teammate-SHAPED leftovers are dead workflow/named one-shots
      // (e.g. killed lanes whose SubagentStop was lost) and must go.
      if (!hasTeammateTypedTask) {
        roster.delete(id)
        continue
      }
      if (tracked.backgroundTasksAuthoritative && tracked.state === 'working') {
        tracked.state = 'idle'
      }
      continue
    }
    roster.delete(id)
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
    // Why: TeammateIdle is teammate-only proof; the flag keeps this entry
    // exempt from one-shot removal on SubagentStop and fold omission.
    tracked.teammate = true
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
      tracked.teammate = true
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
