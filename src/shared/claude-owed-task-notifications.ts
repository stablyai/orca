/** Background tasks the MAIN agent launched in this session, keyed by the task id Claude reports at
 *  launch and repeats in the task's `<task-notification>`.
 *
 *  Why: Claude owes the main agent one notification for every background task that ends, and
 *  delivers it after the task stops running — up to a whole main-agent turn later, and after a Stop
 *  whose inventory is already empty. A pane with a notification still owed is not finished (#23942).
 *  Captures: __fixtures__/claude-task-notification-hooks.jsonl. */
export type ClaudeLaunchedBackgroundTasks = Map<string, ClaudeLaunchedBackgroundTask>

type ClaudeLaunchedBackgroundTask = {
  kind: 'agent' | 'shell'
  /** A current child ended before its MAIN-agent launch identified the parent. */
  launchUnconfirmed?: true
  /** When the task was seen to end; set while its notification has not reached the main agent. */
  notificationOwedAt?: number
  /** A sub-agent already announced (or given up on); kept only because it can be resumed. */
  settled?: true
  /** A delivered notification, distinct from a lease that merely gave up waiting. */
  notificationDelivered?: true
}

/** How long an idle main agent is still expected to be woken. Claude's Stop is never final and no
 *  hook says its queue is empty, so an owed notification is an expectation, not an obligation:
 *  captured deliveries land 40–130 ms after the main agent goes idle, and hooks are separate posts
 *  that can be lost or arrive out of order. Matches Claude's own idle threshold (its idle_prompt
 *  fired 60 s after the last Stop in every capture that idled that long). */
export const CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS = 60_000

/** A session can launch tasks without bound; past this, settled ones are forgotten first, and a
 *  launch that finds none is not tracked rather than displacing a task still being waited on. */
const CLAUDE_LAUNCHED_BACKGROUND_TASK_LIMIT = 256

/** The task id a main-agent PostToolUse reports for work it left running in the background. */
export function readClaudeBackgroundTaskLaunch(
  toolName: string | undefined,
  toolResponse: unknown
): { id: string; kind: ClaudeLaunchedBackgroundTask['kind'] } | null {
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    return null
  }
  const response: Record<string, unknown> = { ...toolResponse }
  const agentId =
    response.isAsync === true && typeof response.agentId === 'string' ? response.agentId.trim() : ''
  if (agentId.length > 0) {
    return { id: agentId, kind: 'agent' }
  }
  // Why: a Monitor is launched as `taskId` but listed and notified exactly like a shell.
  const rawShellId =
    response.backgroundTaskId ?? (toolName === 'Monitor' ? response.taskId : undefined)
  const shellId = typeof rawShellId === 'string' ? rawShellId.trim() : ''
  return shellId.length > 0 ? { id: shellId, kind: 'shell' } : null
}

export function recordClaudeBackgroundTaskLaunch(
  tasks: ClaudeLaunchedBackgroundTasks,
  launch: { id: string; kind: ClaudeLaunchedBackgroundTask['kind'] }
): void {
  const previous = tasks.get(launch.id)
  if (previous) {
    if (previous.kind === launch.kind) {
      previous.launchUnconfirmed = undefined
    }
    return
  }
  if (makeClaudeTaskRecordRoom(tasks)) {
    tasks.set(launch.id, { kind: launch.kind })
  }
}

function makeClaudeTaskRecordRoom(tasks: ClaudeLaunchedBackgroundTasks): boolean {
  if (tasks.size < CLAUDE_LAUNCHED_BACKGROUND_TASK_LIMIT) {
    return true
  }
  let settledId: string | undefined
  for (const [id, task] of tasks) {
    if (task.launchUnconfirmed) {
      tasks.delete(id)
      return true
    }
    if (settledId === undefined && task.settled) {
      settledId = id
    }
  }
  if (settledId === undefined) {
    return false
  }
  tasks.delete(settledId)
  return true
}

/** Child lifecycle posts may beat the parent's launch; only the later launch makes this debt. */
export function recordClaudeUnconfirmedAgentEnd(
  tasks: ClaudeLaunchedBackgroundTasks,
  agentId: string,
  now: number
): void {
  if (!tasks.has(agentId) && makeClaudeTaskRecordRoom(tasks)) {
    tasks.set(agentId, { kind: 'agent', launchUnconfirmed: true, notificationOwedAt: now })
  }
}

/** An own notification can arrive before both launch and end while the runtime child is known. */
export function recordClaudeUnconfirmedAgentNotification(
  tasks: ClaudeLaunchedBackgroundTasks,
  agentId: string
): void {
  if (!tasks.has(agentId) && makeClaudeTaskRecordRoom(tasks)) {
    tasks.set(agentId, { kind: 'agent', launchUnconfirmed: true })
  }
}

/** A recorded sub-agent resumed under the same task id; its next end may notify again. */
export function markClaudeBackgroundAgentRunning(
  tasks: ClaudeLaunchedBackgroundTasks | undefined,
  agentId: string
): void {
  const task = tasks?.get(agentId)
  if (task?.kind === 'agent') {
    task.notificationOwedAt = undefined
    task.settled = undefined
    task.notificationDelivered = undefined
  }
}

/** A launched sub-agent finished: Claude now owes the main agent its notification. */
export function oweClaudeAgentTaskNotification(
  tasks: ClaudeLaunchedBackgroundTasks | undefined,
  agentId: string,
  now: number
): void {
  const task = tasks?.get(agentId)
  if (task?.kind === 'agent' && task.settled !== true) {
    task.notificationOwedAt ??= now
    task.settled = undefined
  }
}

/** A shell's end fires no hook: a main-agent inventory that stopped listing a launched
 *  shell is the only sign it ended. */
export function oweClaudeShellTaskNotifications(
  tasks: ClaudeLaunchedBackgroundTasks,
  runningShellIds: ReadonlySet<string>,
  now: number
): void {
  for (const [id, task] of tasks) {
    if (task.kind === 'shell' && !runningShellIds.has(id)) {
      task.notificationOwedAt ??= now
    }
  }
}

/** The notification arrived. A sub-agent can be resumed and notify again under the same id, so it
 *  stays known; a shell is over, and can be notified before any inventory showed it gone. */
export function settleClaudeTaskNotification(
  tasks: ClaudeLaunchedBackgroundTasks,
  taskId: string
): void {
  const task = tasks.get(taskId)
  if (task) {
    stopOwingClaudeTaskNotification(tasks, taskId, task)
    if (task.kind === 'agent') {
      task.notificationDelivered = true
    }
  }
}

function stopOwingClaudeTaskNotification(
  tasks: ClaudeLaunchedBackgroundTasks,
  taskId: string,
  task: ClaudeLaunchedBackgroundTask
): void {
  if (task.kind === 'agent') {
    task.notificationOwedAt = undefined
    task.settled = true
  } else {
    tasks.delete(taskId)
  }
}

/** The lease runs only while the main agent is idle: a notification queued behind a running turn
 *  is delivered when that turn yields, however long it takes. */
function claudeOwedTaskNotificationExpiry(owedAt: number, mainAgentIdleSince: number): number {
  return Math.max(owedAt, mainAgentIdleSince) + CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS
}

/** Stop waiting for notifications an idle main agent was owed for a whole lease. */
function dropExpiredClaudeOwedTaskNotifications(
  tasks: ClaudeLaunchedBackgroundTasks,
  mainAgentIdleSince: number,
  now: number
): void {
  for (const [id, task] of tasks) {
    if (
      task.launchUnconfirmed !== true &&
      task.notificationOwedAt !== undefined &&
      claudeOwedTaskNotificationExpiry(task.notificationOwedAt, mainAgentIdleSince) <= now
    ) {
      stopOwingClaudeTaskNotification(tasks, id, task)
    }
  }
}

/** When the last notification still owed to an idle main agent stops being waited for. */
export function claudeOwedTaskNotificationDeadline(
  tasks: ClaudeLaunchedBackgroundTasks | undefined,
  mainAgentIdleSince: number
): number | undefined {
  let deadline: number | undefined
  for (const task of tasks?.values() ?? []) {
    if (task.launchUnconfirmed !== true && task.notificationOwedAt !== undefined) {
      const expiry = claudeOwedTaskNotificationExpiry(task.notificationOwedAt, mainAgentIdleSince)
      deadline = deadline === undefined ? expiry : Math.max(deadline, expiry)
    }
  }
  return deadline
}

/** The main agent stopped the task itself. Claude sends no notification for a shell it was told to
 *  stop; a stopped sub-agent still gets one (`killed`) and no turn end, so it never becomes owed. */
export function forgetStoppedClaudeShellTask(
  tasks: ClaudeLaunchedBackgroundTasks,
  taskId: string
): void {
  if (tasks.get(taskId)?.kind === 'shell') {
    tasks.delete(taskId)
  }
}

function claudeOwedTaskNotificationKinds(tasks: ClaudeLaunchedBackgroundTasks | undefined): {
  agent: boolean
  shell: boolean
} {
  const owed = { agent: false, shell: false }
  for (const task of tasks?.values() ?? []) {
    if (task.launchUnconfirmed !== true && task.notificationOwedAt !== undefined) {
      owed[task.kind] = true
    }
  }
  return owed
}

/** What a pane is still owed, after giving up on what an idle main agent was owed for a whole
 *  lease. `mainAgentIdleSince` is undefined when the main agent is going idle on this very event. */
export function claudeLiveOwedTaskNotificationKinds(
  tasks: ClaudeLaunchedBackgroundTasks | undefined,
  mainAgentIdle: boolean,
  mainAgentIdleSince: number | undefined,
  now = Date.now()
): { agent: boolean; shell: boolean } {
  if (tasks && mainAgentIdle) {
    dropExpiredClaudeOwedTaskNotifications(tasks, mainAgentIdleSince ?? now, now)
  }
  return claudeOwedTaskNotificationKinds(tasks)
}
