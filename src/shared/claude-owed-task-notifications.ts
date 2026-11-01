import { isRecord } from './agent-status-child-work-value-guards'
import { runsOrcaOrchestrationWait } from './orca-cli-invocations'

/** Main-agent background tasks keyed by launch/notification task ID. Notifications can arrive a turn after task end and an empty Stop; owed work keeps the pane active (#23942). Captures: __fixtures__/claude-task-notification-hooks.jsonl. */
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
  /** A shell blocked on worker agents (`orca orchestration check --wait`): agent work, not monitoring. */
  awaitsAgents?: true
  /** Known only from the main agent's task list (e.g. after a listener restart): a subagent may own it, so it owes the main agent nothing. */
  listedOnly?: true
}

/** An idle notification lease is expectation, not proof: Stop never promises an empty queue and posts can be lost/reordered. Captured deliveries took 40–130ms; Claude idle_prompt consistently fired after 60s. */
export const CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS = 60_000

/** Bound history by evicting settled tasks first; reject new tracking rather than displace pending debt when none are settled. */
const CLAUDE_LAUNCHED_BACKGROUND_TASK_LIMIT = 256

/** The task id a main-agent PostToolUse reports for work it left running in the background. */
export function readClaudeBackgroundTaskLaunch(
  toolName: string | undefined,
  toolResponse: unknown,
  toolInput?: unknown
):
  | (Pick<ClaudeLaunchedBackgroundTask, 'kind' | 'awaitsAgents'> & {
      id: string
    })
  | null {
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
  if (shellId.length === 0) {
    return null
  }
  const command = isRecord(toolInput) ? toolInput.command : undefined
  return {
    id: shellId,
    kind: 'shell',
    ...(runsOrcaOrchestrationWait(command) ? { awaitsAgents: true as const } : {})
  }
}

export function recordClaudeBackgroundTaskLaunch(
  tasks: ClaudeLaunchedBackgroundTasks,
  launch: Pick<ClaudeLaunchedBackgroundTask, 'kind' | 'awaitsAgents' | 'listedOnly'> & {
    id: string
  }
): void {
  const previous = tasks.get(launch.id)
  if (previous) {
    if (previous.kind === launch.kind) {
      previous.awaitsAgents ||= launch.awaitsAgents
      if (!launch.listedOnly) {
        previous.launchUnconfirmed = undefined
        previous.listedOnly = undefined
      }
    }
    return
  }
  if (makeClaudeTaskRecordRoom(tasks)) {
    tasks.set(launch.id, {
      kind: launch.kind,
      ...(launch.awaitsAgents ? { awaitsAgents: true as const } : {}),
      ...(launch.listedOnly ? { listedOnly: true as const } : {})
    })
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
    tasks.set(agentId, {
      kind: 'agent',
      launchUnconfirmed: true,
      notificationOwedAt: now
    })
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

/** Shells emit no end hook; omission from the main-agent inventory is their only completion evidence. */
export function oweClaudeShellTaskNotifications(
  tasks: ClaudeLaunchedBackgroundTasks,
  runningShellIds: ReadonlySet<string>,
  now: number
): void {
  for (const [id, task] of tasks) {
    if (task.kind === 'shell' && !runningShellIds.has(id)) {
      if (task.listedOnly) {
        tasks.delete(id)
      } else {
        task.notificationOwedAt ??= now
      }
    }
  }
}

/** Retain resumable subagents for future notifications; shells end permanently and may notify before inventory omission. */
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

/** A provider kill ends notification debt without claiming delivery. */
export function stopOwingClaudeAgentTaskNotification(
  tasks: ClaudeLaunchedBackgroundTasks | undefined,
  taskId: string
): void {
  const task = tasks?.get(taskId)
  if (task?.kind === 'agent' && tasks) {
    stopOwingClaudeTaskNotification(tasks, taskId, task)
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

/** Count the lease only while the main agent is idle; queued notifications wait for an arbitrarily long running turn to yield. */
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

/** Stopped shells receive no notification; killed subagents do, without a turn end, so their notification never becomes owed. */
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
      owed[task.awaitsAgents ? 'agent' : task.kind] = true
    }
  }
  return owed
}

/** A recorded worker wait lives from launch until its notification is delivered, stopped or given up on. */
export function claudeTasksAwaitAgents(tasks: ClaudeLaunchedBackgroundTasks | undefined): boolean {
  for (const task of tasks?.values() ?? []) {
    if (task.awaitsAgents) {
      return true
    }
  }
  return false
}

/** Return owed kinds after expiring idle debt; undefined mainAgentIdleSince means this event is the idle boundary. */
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
