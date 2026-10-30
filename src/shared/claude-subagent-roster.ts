import type { AgentSubagentSnapshot } from './agent-status-types'
import type { ClaudeBackgroundAgentTask } from './claude-background-task-inventory'

/** Match the wire ID cap at upsert so an invisible oversized child cannot keep the pane working. */
const CLAUDE_SUBAGENT_ID_MAX_LENGTH = 64

/** Track provider lifecycle IDs: one-shots leave on stop; Claude 2.1.21x teammates idle between resumable turns. Idle never gates work; only TeammateIdle-confirmed idle rows survive lead-Stop folds (#8825). */
export type ClaudeSubagentRoster = Map<string, TrackedClaudeSubagent>

export type TrackedClaudeSubagent = {
  agentType?: string
  description?: string
  startedAt: number
  /** Idle teammates remain visible/resumable without gating pane work. */
  state: 'working' | 'idle'
  /** TeammateIdle confirms persistent identity for life. Reap unconfirmed idle workflow lanes at the next complete inventory to prevent #8825 idle piles. */
  confirmedTeammate?: true
  /** Snapshot/inventory rows lack live lifecycle proof; complete inventories may reap them even with teammate-shaped IDs. Live activity clears this. */
  backgroundTasksAuthoritative?: boolean
  /** No live event confirms this restored claim. Liveness may reap it while an idle parent emits no inventory; any child activity clears this. */
  restoredFromSnapshot?: boolean
  /** An id-exact subagent task proves listing mode for life; later complete omission means finished/killed even with a teammate-shaped ID. */
  listedAsSubagentTask?: true
  /** The `description` of the lead's Agent call that spawned this teammate. Claude lists the
   *  teammate's `background_tasks` entry under that same description (its id is unrelated), so a
   *  complete inventory without it means the teammate was stopped (`TaskStop` fires no hook). */
  teammateTaskDescription?: string
}

/** Claude 2.1.280 API errors can end children with only StopFailure(agent_id), skipping SubagentStop/TeammateIdle. */
export function isClaudeChildTurnEndEvent(
  eventName: unknown,
  agentId: string | undefined
): eventName is 'SubagentStop' | 'StopFailure' {
  return eventName === 'SubagentStop' || (eventName === 'StopFailure' && agentId !== undefined)
}

/** Named teammate IDs use a<name>-<hex>, one-shots a<hex>. Teammate task IDs differ, so list omission alone proves nothing. */
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
    existing.state = 'working'
    existing.agentType = fields.agentType ?? existing.agentType
    existing.description = fields.description ?? existing.description
    // Live activity restores lifecycle ownership; teammate-shaped IDs may be absent from task inventories. Folds re-tag their own recreations.
    existing.backgroundTasksAuthoritative = undefined
    // Live confirmation makes restored rows count as current child work again.
    existing.restoredFromSnapshot = undefined
    return
  }
  roster.set(id, {
    state: 'working',
    startedAt: now,
    agentType: fields.agentType,
    description: fields.description
  })
}

/** Stop removes one-shots and proven workflow lanes; teammate-shaped Claude 2.1.21x IDs instead idle between turns. */
export function stopClaudeSubagent(roster: ClaudeSubagentRoster, id: string): void {
  const tracked = roster.get(id)
  if (!tracked) {
    return
  }
  if (!isClaudeTeammateLifecycleId(id) || tracked.listedAsSubagentTask === true) {
    roster.delete(id)
    return
  }
  tracked.backgroundTasksAuthoritative = undefined
  tracked.restoredFromSnapshot = undefined
  tracked.state = 'idle'
}

/** Complete inventories own id-exact subagent tasks: keep running matches, remove stopped/omitted rows and recreate unseen running tasks. Protect only live, never-subagent-listed teammates that work or have TeammateIdle proof; a provably omitted spawn description overrides that protection. Empty inventories clear all. */
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
  const listedTeammateDescriptions = readProvableClaudeTeammateDescriptions(roster, tasks)
  for (const task of tasks) {
    if (task.teammate) {
      continue
    }
    listedIds.add(task.id)
    const existing = roster.get(task.id)
    if (existing) {
      if (!task.running) {
        roster.delete(task.id)
        continue
      }
      // Inventory-confirmed running work overrides a racing stop that parked the row.
      existing.state = 'working'
      existing.agentType = task.agentType ?? existing.agentType
      existing.description = task.description ?? existing.description
      existing.listedAsSubagentTask = true
      // Current inventory confirms the restored claim, preventing liveness reaping.
      existing.restoredFromSnapshot = undefined
      continue
    }
    if (!task.running) {
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
        isClaudeTeammateLifecycleId(id) &&
        // Reap unconfirmed idle workflow lanes to prevent rebuilding the #8825 idle pile.
        (tracked.state === 'working' || tracked.confirmedTeammate === true) &&
        !(
          listedTeammateDescriptions !== null &&
          tracked.teammateTaskDescription !== undefined &&
          !isClaudeTeammateDescriptionListed(
            tracked.teammateTaskDescription,
            listedTeammateDescriptions
          )
        )
      ) {
        continue
      }
      roster.delete(id)
    }
  }
}

/** Listed teammate descriptions, or null when they cannot prove which tracked teammate stopped.
 *  Why: a stop is inferred from absence, so every listed teammate must match a recorded spawn
 *  description; an undescribed, unknown, or differently formatted entry could be a live row. */
function readProvableClaudeTeammateDescriptions(
  roster: ClaudeSubagentRoster,
  tasks: ClaudeBackgroundAgentTask[]
): ReadonlySet<string> | null {
  const recorded: string[] = []
  for (const tracked of roster.values()) {
    if (tracked.teammateTaskDescription !== undefined) {
      recorded.push(tracked.teammateTaskDescription)
    }
  }
  const listed = new Set<string>()
  for (const task of tasks) {
    if (!task.teammate) {
      continue
    }
    const description = task.description
    if (!description || !recorded.some((r) => claudeTeammateDescriptionMatches(r, description))) {
      return null
    }
    listed.add(description)
  }
  return listed
}

function claudeTeammateDescriptionMatches(recorded: string, listed: string): boolean {
  if (recorded === listed) {
    return true
  }
  // Claude clips inventory descriptions; ambiguous prefix matches must retain every possible owner.
  const clippingMarker = /\u2026 \[\+\d+ chars\]$/.exec(listed)
  return clippingMarker !== null && recorded.startsWith(listed.slice(0, clippingMarker.index))
}

function isClaudeTeammateDescriptionListed(
  description: string,
  listedDescriptions: ReadonlySet<string>
): boolean {
  for (const listed of listedDescriptions) {
    if (claudeTeammateDescriptionMatches(description, listed)) {
      return true
    }
  }
  return false
}

/** Remember which `background_tasks` description lists a teammate the lead's Agent call spawned. */
export function recordClaudeTeammateTaskDescription(
  roster: ClaudeSubagentRoster,
  agentId: string,
  fields: { agentType?: string; description: string },
  now: number
): void {
  if (!isClaudeTeammateLifecycleId(agentId) || agentId.length > CLAUDE_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  // Why idle: hook requests are unordered, so this can precede the SubagentStart that revives the
  // row to working, or follow the teammate's own stop. Idle never gates the pane, and an
  // unconfirmed idle row is reaped at the next complete lead-Stop fold.
  const tracked = roster.get(agentId) ?? {
    state: 'idle',
    startedAt: now,
    agentType: fields.agentType
  }
  tracked.teammateTaskDescription = fields.description
  roster.set(agentId, tracked)
}

/** Drop restored rows that no current-runtime child activity has confirmed. */
export function reapUnconfirmedRestoredClaudeSubagents(roster: ClaudeSubagentRoster): boolean {
  let changed = false
  for (const [id, tracked] of roster) {
    if (tracked.restoredFromSnapshot === true) {
      roster.delete(id)
      changed = true
    }
  }
  return changed
}

export function claudeRosterHasRestoredSnapshotSubagent(
  roster: ClaudeSubagentRoster | undefined
): boolean {
  if (!roster) {
    return false
  }
  for (const tracked of roster.values()) {
    if (tracked.restoredFromSnapshot === true) {
      return true
    }
  }
  return false
}

/** Match a<name>-<hex> with a hyphen-free suffix so rev cannot claim rev-two’s IDs while hyphenated names still match. */
export function claudeTeammateIdMatchesName(id: string, name: string): boolean {
  const prefix = `a${name}-`
  return id.startsWith(prefix) && !id.slice(prefix.length).includes('-')
}

/** TeammateIdle means alive/awaiting mail on Claude 2.1.21x. Match embedded lifecycle names only; agent-type fallback could idle unrelated work after a lost start hook. Confirmation preserves idle rows across lead Stops. */
export function idleClaudeTeammateByName(roster: ClaudeSubagentRoster, name: string): boolean {
  let changed = false
  for (const [id, tracked] of roster) {
    if (claudeTeammateIdMatchesName(id, name)) {
      changed = changed || tracked.state !== 'idle' || tracked.confirmedTeammate !== true
      tracked.backgroundTasksAuthoritative = undefined
      tracked.restoredFromSnapshot = undefined
      tracked.state = 'idle'
      tracked.confirmedTeammate = true
    }
  }
  return changed
}

/** Idle teammates are alive but must not pin the finished pane’s spinner (#8825). */
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

/** A working child observed in this listener runtime, not merely restored from disk. */
export function claudeRosterHasRuntimeWorkingSubagent(
  roster: ClaudeSubagentRoster | undefined
): boolean {
  if (!roster) {
    return false
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'working' && tracked.restoredFromSnapshot !== true) {
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
  // Sort unstable hook-arrival order so equal rosters serialize identically for downstream dedupe.
  snapshots.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return snapshots
}
