import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'

/** Mirrors the wire-normalization id cap in agent-status-types. Enforced at
 *  upsert so an over-long id can't gate the pane 'working' while being
 *  invisible in the emitted snapshots (which drop such ids). */
const CLAUDE_SUBAGENT_ID_MAX_LENGTH = 64

/** Currently WORKING subagents/teammates tracked for one Claude pane, keyed
 *  by the provider-assigned `agent_id` from SubagentStart/SubagentStop
 *  payloads. The roster intentionally holds only working children: a child
 *  that finished leaves the sidebar immediately. Claude gives no other
 *  finish signal for named agents — their `background_tasks` teammate
 *  entries stay `status: "running"` forever, even after they complete
 *  (verified live on 2.1.210) — so retaining "idle" rows piled up dead
 *  entries for hours. A teammate resumed later re-earns its row via
 *  SubagentStart. */
export type ClaudeSubagentRoster = Map<string, TrackedClaudeSubagent>

export type TrackedClaudeSubagent = {
  agentType?: string
  description?: string
  startedAt: number
  /** The id came from a persisted snapshot or background_tasks, not live
   *  lifecycle events, so it may be a phantom whose SubagentStop was never
   *  observed (Orca restart). A present complete task list omitting it
   *  removes it even when teammate-shaped, so it can't gate the pane
   *  'working' forever. Cleared once live activity re-tracks the id. */
  backgroundTasksAuthoritative?: boolean
  /** A subagent-typed background task listed this lifecycle id id-exact
   *  (workflow/named lanes) — proof the task list tracks this id, so a later
   *  complete list omitting it means finished/killed even though the id is
   *  teammate-shaped. Never cleared: the listing mode of an id can't change
   *  mid-life. */
  listedAsSubagentTask?: true
}

/** One agent entry from the `background_tasks` array Claude attaches to Stop
 *  (and SubagentStop) hook payloads. Non-agent task types (background shells,
 *  crons) are filtered out at read time. */
export type ClaudeBackgroundAgentTask = {
  id: string
  agentType?: string
  description?: string
  running: boolean
  /** True for `type: "teammate"` entries. Their ids never match lifecycle
   *  agent_ids and they report "running" permanently — even after the named
   *  agent finished — so they carry no per-agent state at all. */
  teammate: boolean
}

/** Agent-team/named-agent lifecycle ids are `a<name>-<hex>` while one-shot
 *  ids are hyphen-free (`a<hex>`). Such ids are never listed as task ids in
 *  `background_tasks`, so omission from the list proves nothing for them. */
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
  const existing = roster.get(id)
  if (existing) {
    existing.agentType = fields.agentType ?? existing.agentType
    existing.description = fields.description ?? existing.description
    // Why: live activity proves the lifecycle stream owns this id again;
    // background_tasks omission must stop reaping it (teammate-shaped ids
    // never appear there). The fold re-tags its own recreations after this.
    existing.backgroundTasksAuthoritative = undefined
    return
  }
  // Why: beyond the wire cap extra rows would be invisible anyway; with only
  // working entries tracked there is nothing safe to evict.
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return
  }
  roster.set(id, {
    startedAt: now,
    agentType: fields.agentType,
    description: fields.description
  })
}

/** SubagentStop: the finished child leaves the sidebar immediately. This
 *  applies to teammates/named agents too — SubagentStop is their only
 *  reliable finish signal (their background_tasks entries never stop
 *  "running"), and a resumed teammate re-earns its row via SubagentStart. */
export function finishClaudeSubagent(roster: ClaudeSubagentRoster, id: string): void {
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
 *  The list is authoritative for subagent-typed entries only: a running
 *  one-shot/workflow lane is always listed under its lifecycle `agent_id`,
 *  foreground children cannot span a lead Stop, and finished tasks drop from
 *  the list. Teammate-typed entries prove nothing per-agent (unrelated ids,
 *  permanently "running") — but their PRESENCE proves the session has
 *  named-agent/teammate machinery, and their total absence from a complete
 *  inventory proves no teammate-shaped child can still be alive. So:
 *  - an empty list proves nothing is left alive → clear the roster;
 *  - an id-exact subagent-typed match that is running is trusted fully and
 *    tagged listedAsSubagentTask; one reported not running is removed;
 *  - an unmatched RUNNING subagent-typed entry is a one-shot this listener
 *    never saw start (Orca/relay restart mid-run) → recreate it;
 *  - an unlisted entry is finished or dead (its SubagentStop was lost) →
 *    remove it — UNLESS it is teammate-shaped, live-tracked, never
 *    subagent-listed, and the list still shows teammate-typed tasks: that is
 *    a named agent mid-run whose id simply never appears, and removing it
 *    would drop the pane's done-gate. */
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
  const pendingRunningTasks = new Map<string, ClaudeBackgroundAgentTask>()
  const hasTeammateTypedTask = tasks.some((task) => task.teammate)
  for (const task of tasks) {
    if (task.teammate) {
      continue
    }
    listedIds.add(task.id)
    const existing = roster.get(task.id)
    if (existing) {
      if (!task.running) {
        roster.delete(task.id)
        pendingRunningTasks.delete(task.id)
        continue
      }
      existing.agentType = task.agentType ?? existing.agentType
      existing.description = task.description ?? existing.description
      existing.listedAsSubagentTask = true
      continue
    }
    if (!task.running) {
      pendingRunningTasks.delete(task.id)
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
      created.listedAsSubagentTask = true
    } else {
      // Why: a full roster may still contain stale entries that this same
      // inventory will reap. Retry after cleanup so a replacement stays live.
      pendingRunningTasks.set(task.id, task)
    }
  }
  if (options?.inventoryComplete !== false) {
    for (const [id, tracked] of roster) {
      if (listedIds.has(id)) {
        continue
      }
      if (
        hasTeammateTypedTask &&
        !tracked.backgroundTasksAuthoritative &&
        tracked.listedAsSubagentTask !== true &&
        isClaudeTeammateLifecycleId(id)
      ) {
        continue
      }
      roster.delete(id)
    }
  }
  for (const task of pendingRunningTasks.values()) {
    if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
      break
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
      created.listedAsSubagentTask = true
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

/** Remove a teammate's rows from a TeammateIdle hook, which is keyed by name.
 *  Idle means not working, and only working children keep rows — this is the
 *  fallback finish signal when a SubagentStop was lost. Named teammates embed
 *  their name in `agent_id` (`a<name>-<hex>`), which is the only unambiguous
 *  mapping. Agent types are independent of teammate names, so a type fallback
 *  could remove unrelated live work when the teammate's start hook was lost. */
export function removeClaudeTeammateByName(roster: ClaudeSubagentRoster, name: string): boolean {
  let changed = false
  for (const id of roster.keys()) {
    if (claudeTeammateIdMatchesName(id, name)) {
      roster.delete(id)
      changed = true
    }
  }
  return changed
}

export function claudeRosterHasWorkingSubagent(roster: ClaudeSubagentRoster | undefined): boolean {
  return roster !== undefined && roster.size > 0
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
      state: 'working',
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
