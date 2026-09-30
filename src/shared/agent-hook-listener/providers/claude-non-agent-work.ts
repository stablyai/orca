// Claude's background work that is not an agent (a shell, a monitor, a workflow), per pane and by
// Claude's own task id. It starts at the tool call that launches the task or at the inventory Claude
// attaches to Stop, and ends at Claude's own record of the task's end: the next inventory, a
// TaskStop result, or the task-notification row Claude writes to its transcript when the task
// ends. A new process's session start ends them too; /clear does not, since the task outlives it.
import type { AgentChildWorkKind } from '../../agent-status-child-work'
import { isAgentChildWorkKind } from '../../agent-status-child-work-liveness'
import type { ClaudeBackgroundNonAgentTask } from '../../claude-background-task-inventory'
import {
  classifyClaudeBackgroundTaskKind,
  isClaudeBackgroundTaskStatusTerminal
} from '../../claude-background-task-kind'
import { readJsonlCursor } from '../../codex-rollout-jsonl-cursor'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'

export type ClaudeNonAgentTask = {
  kind: AgentChildWorkKind
  /** The tool call that launched it, when Orca saw the launch; Claude's end record repeats it. */
  launchToolUseId?: string
}

/** Replaced whole on every write, never mutated, so a snapshot of it is a reference. */
export type ClaudeNonAgentWork = {
  tasks: ReadonlyMap<string, ClaudeNonAgentTask>
  /** Running work Claude reported without an id or a type, or past the id cap; of Claude's own
   *  records, only an inventory clears it. */
  hasUnnamedRunning: boolean
}

const MAX_TASKS_PER_PANE = 64
const MAX_ID_LENGTH = 256

function isClaudeTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function writeClaudeNonAgentWork(
  state: HookListenerState,
  paneKey: string,
  tasks: Map<string, ClaudeNonAgentTask>,
  hasUnnamedRunning: boolean
): void {
  if (tasks.size === 0 && !hasUnnamedRunning) {
    state.claudeNonAgentWorkByPaneKey.delete(paneKey)
    return
  }
  state.claudeNonAgentWorkByPaneKey.set(paneKey, { tasks, hasUnnamedRunning })
}

function addCapped(
  tasks: Map<string, ClaudeNonAgentTask>,
  taskId: string,
  task: ClaudeNonAgentTask
): boolean {
  if (tasks.has(taskId) || tasks.size < MAX_TASKS_PER_PANE) {
    tasks.set(taskId, task)
    return true
  }
  return false
}

export function claudePaneHasNonAgentWork(state: HookListenerState, paneKey: string): boolean {
  const work = state.claudeNonAgentWorkByPaneKey.get(paneKey)
  return work !== undefined && (work.tasks.size > 0 || work.hasUnnamedRunning)
}

/** Whether a task's end record can be matched: the watch reads the transcript only for these. */
export function claudePaneHasLaunchRecordedTask(
  state: HookListenerState,
  paneKey: string
): boolean {
  const tasks = state.claudeNonAgentWorkByPaneKey.get(paneKey)?.tasks
  return tasks !== undefined && [...tasks.values()].some((task) => task.launchToolUseId)
}

export type ClaudeBackgroundTaskLaunch = { taskId: unknown; kind: AgentChildWorkKind }

/** The background task a tool result launched, if any: a shell's `backgroundTaskId`, its kind
 *  unknown until an inventory types it (r1-s1); otherwise an `async_launched` result's `taskId`
 *  and `taskType` (captured for workflows, r6-w1..w4). Skips agent kinds, since agents are the
 *  rosters', but admits unknown ones, which fail active. Skips any other result, e.g. a remote
 *  `remote_launched` launch, which the next inventory still records. */
export function readClaudeBackgroundTaskLaunch(
  response: Record<string, unknown>
): ClaudeBackgroundTaskLaunch | undefined {
  if (response.backgroundTaskId !== undefined) {
    return { taskId: response.backgroundTaskId, kind: 'unknown' }
  }
  if (response.status !== 'async_launched' || response.taskId === undefined) {
    return undefined
  }
  // Temporary: a teammate launch (uncaptured) reads unknown until the table calls it an agent.
  const kind = classifyClaudeBackgroundTaskKind(response.taskType)
  return isAgentChildWorkKind(kind) ? undefined : { taskId: response.taskId, kind }
}

/** The main agent's launching tool call named a background task. A kind an inventory already gave
 *  it wins over the launch's. */
export function recordClaudeNonAgentTaskLaunch(
  state: HookListenerState,
  paneKey: string,
  launch: ClaudeBackgroundTaskLaunch,
  launchToolUseId: unknown
): void {
  const { taskId } = launch
  if (!isClaudeTaskId(taskId)) {
    return
  }
  const previous = state.claudeNonAgentWorkByPaneKey.get(paneKey)
  const tasks = new Map(previous?.tasks)
  const added = addCapped(tasks, taskId, {
    kind: tasks.get(taskId)?.kind ?? launch.kind,
    ...(isClaudeTaskId(launchToolUseId) ? { launchToolUseId } : {})
  })
  writeClaudeNonAgentWork(state, paneKey, tasks, (previous?.hasUnnamedRunning ?? false) || !added)
}

/** Claude recorded the task's end. `launchToolUseId`, when given, must be the one recorded at
 *  launch: a transcript row is trusted only for the exact launch it names. Returns whether a task
 *  was retired. */
export function retireClaudeNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string,
  launchToolUseId?: string
): boolean {
  const previous = state.claudeNonAgentWorkByPaneKey.get(paneKey)
  const task = previous?.tasks.get(taskId)
  if (
    !previous ||
    !task ||
    (launchToolUseId !== undefined && task.launchToolUseId !== launchToolUseId)
  ) {
    return false
  }
  const tasks = new Map(previous.tasks)
  tasks.delete(taskId)
  writeClaudeNonAgentWork(state, paneKey, tasks, previous.hasUnnamedRunning)
  return true
}

/** A main-agent inventory is Claude's whole list: it replaces the record, keeping the launch each
 *  still-running task was recorded with. */
export function replaceClaudeNonAgentWorkFromInventory(
  state: HookListenerState,
  paneKey: string,
  inventory: {
    runningNonAgentTasks: readonly ClaudeBackgroundNonAgentTask[]
    hasUnnamedRunningNonAgentTask: boolean
  }
): void {
  const previous = state.claudeNonAgentWorkByPaneKey.get(paneKey)?.tasks
  const tasks = new Map<string, ClaudeNonAgentTask>()
  let hasUnnamedRunning = inventory.hasUnnamedRunningNonAgentTask
  for (const { id, kind } of inventory.runningNonAgentTasks) {
    const launchToolUseId = previous?.get(id)?.launchToolUseId
    const added =
      isClaudeTaskId(id) &&
      addCapped(tasks, id, { kind, ...(launchToolUseId ? { launchToolUseId } : {}) })
    hasUnnamedRunning ||= !added
  }
  writeClaudeNonAgentWork(state, paneKey, tasks, hasUnnamedRunning)
}

const TASK_NOTIFICATION_OPEN = '<task-notification>'
const TASK_NOTIFICATION_PATTERN = /^<task-notification>([\s\S]*)<\/task-notification>$/

function readTaskNotificationField(body: string, field: string): string | undefined {
  return new RegExp(`<${field}>([^<]*)</${field}>`).exec(body)?.[1]?.trim()
}

/** Claude writes a `queue-operation` `enqueue` row carrying a task's notification the moment the
 *  task ends, even while Claude idles and sends no hook: a shell however it ended (finished, killed
 *  with its turn's Ctrl+C or from /tasks: r1-s1, r1-s9, r3-tasks-run1), a workflow only when it
 *  completes (r6-w1, r6-w2; one stopped or paused from /tasks writes nothing, r6-w3, r7-w6b, so it
 *  leaves on the next inventory). A prompt typed while Claude is busy writes the same row with
 *  only its text (r3-typed-run1), so the row carries no provenance of its own: it retires a task
 *  only when it is exactly one terminal notification naming both the task id and the tool call
 *  Orca recorded at launch, which Claude mints fresh for each launch.
 *  Returns whether a task was retired. */
export function retireClaudeNonAgentTaskFromQueueRow(
  state: HookListenerState,
  paneKey: string,
  row: Record<string, unknown>
): boolean {
  if (row.type !== 'queue-operation' || row.operation !== 'enqueue') {
    return false
  }
  const content = typeof row.content === 'string' ? row.content.trim() : ''
  const body = TASK_NOTIFICATION_PATTERN.exec(content)?.[1]
  if (body === undefined || body.includes(TASK_NOTIFICATION_OPEN)) {
    return false
  }
  const taskId = readTaskNotificationField(body, 'task-id')
  const toolUseId = readTaskNotificationField(body, 'tool-use-id')
  const status = readTaskNotificationField(body, 'status')?.toLowerCase()
  return (
    taskId !== undefined &&
    toolUseId !== undefined &&
    toolUseId.length > 0 &&
    status !== undefined &&
    isClaudeBackgroundTaskStatusTerminal(status) &&
    retireClaudeNonAgentTask(state, paneKey, taskId, toolUseId)
  )
}

/** Substring test for a line that can be a task's end row. Why both: a `prompt_snapshot`
 *  attachment quotes the notification tag on every tool call. */
export function mayBeClaudeTaskEndLine(line: string): boolean {
  return line.includes('"type":"queue-operation"') && line.includes(TASK_NOTIFICATION_OPEN)
}

/** How far back a launch's end row is looked for: it can precede the launch's hook only by the
 *  rows Claude writes around that one tool call. */
const LAUNCH_END_LOOK_BACK_BYTES = 256 * 1024

/** A task can end before Orca handles the hook that launched it, so its end row can sit behind
 *  where the transcript watch reads from: a cursor armed at the file's end, or one the catch-up
 *  before that hook read past. For an accepted launch hook, reads back once before `offset` for
 *  that row; only the launch's exact id pair matches, so older rows are safe to read. Returns
 *  whether a task was retired. */
export function retireClaudeTaskEndedBeforeLaunchHook(
  state: HookListenerState,
  accepted: AgentHookEventPayload,
  transcript: { filePath: string; offset: number }
): boolean {
  const { paneKey, toolUseId } = accepted
  const tasks = state.claudeNonAgentWorkByPaneKey.get(paneKey)?.tasks.values() ?? []
  if (
    accepted.hookEventName !== 'PostToolUse' ||
    !toolUseId ||
    ![...tasks].some((task) => task.launchToolUseId === toolUseId)
  ) {
    return false
  }
  const offset = Math.max(0, transcript.offset - LAUNCH_END_LOOK_BACK_BYTES)
  const rows = readJsonlCursor(
    { filePath: transcript.filePath, offset, carry: '' },
    (line) => line.includes(toolUseId) && mayBeClaudeTaskEndLine(line)
  )
  return rows?.some((row) => retireClaudeNonAgentTaskFromQueueRow(state, paneKey, row)) ?? false
}
