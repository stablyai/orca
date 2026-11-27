import { classifyClaudeBackgroundTaskKind } from './claude-background-task-kind'
import { isAgentChildWorkKind } from '../../../../agent-status/child-work/agent-status-child-work-liveness'
import { runsOrcaOrchestrationWait } from '../../../../cli/orca-cli-invocations'
import { redactString } from '../../../../observability/redactor'

const CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES = new Set([
  'idle',
  'done',
  'success',
  'succeeded',
  'complete',
  'completed',
  'finished',
  'failed',
  'error',
  'terminated',
  'exited',
  'aborted',
  'expired',
  'skipped',
  'crashed',
  'killed',
  'cancelled',
  'canceled',
  'timed_out'
])

/** Agent entries from Stop/SubagentStop background_tasks; non-agent tasks do not become rows. */
export type ClaudeBackgroundAgentTask = {
  id: string
  agentType?: string
  description?: string
  running: boolean
  /** Teammate IDs never match lifecycle agent_ids and stay running even after completion, so they prove no per-agent state. */
  teammate: boolean
}

// Claude keeps its artifact live-updates and presence sockets open all session and leaves them out of its own in-flight work, but hook rows drop the ambient flag.
const CLAUDE_AMBIENT_ARTIFACT_MONITOR_PREFIXES = [
  'live updates for artifact ',
  'presence on artifact '
]

function isClaudeAmbientArtifactMonitor(taskType: string, description: unknown): boolean {
  return (
    taskType === 'monitor' &&
    typeof description === 'string' &&
    CLAUDE_AMBIENT_ARTIFACT_MONITOR_PREFIXES.some((prefix) => description.startsWith(prefix))
  )
}

/** Absent/malformed inventory on older Claude builds means retain the tracked roster; never clear it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
  truncated: boolean
  hasRunningNonAgentTask: boolean
  /** Ids of the running shell-like entries; one without an id is counted but not listed. */
  runningNonAgentTaskIds: string[]
  /** Running shells blocked on `orca orchestration check --wait`, which recovers them after a listener restart. */
  runningAgentWaitIds: string[]
  /** What each running shell-like entry runs (its command, else its description), except worker waits. */
  runningNonAgentTaskCommands: string[]
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return {
      present: false,
      tasks: [],
      truncated: false,
      hasRunningNonAgentTask: false,
      runningNonAgentTaskIds: [],
      runningAgentWaitIds: [],
      runningNonAgentTaskCommands: []
    }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  let truncated = false
  let hasRunningNonAgentTask = false
  const runningNonAgentTaskIds: string[] = []
  const runningAgentWaitIds: string[] = []
  const runningNonAgentTaskCommands: string[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      truncated = true
      hasRunningNonAgentTask = true
      continue
    }
    const obj = item as Record<string, unknown>
    const taskType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : ''
    const taskStatus = typeof obj.status === 'string' ? obj.status.trim().toLowerCase() : ''
    const isTerminal =
      taskStatus.length > 0 && CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES.has(taskStatus)
    if (taskType.length === 0) {
      truncated = true
      hasRunningNonAgentTask ||= !isTerminal
      continue
    }
    if (isClaudeAmbientArtifactMonitor(taskType, obj.description)) {
      continue
    }
    const isAgentTask = isAgentChildWorkKind(classifyClaudeBackgroundTaskKind(taskType))
    // Why: future non-agent types and nonterminal labels must fail active; only typed agent rows or explicit terminal states can safely retire work.
    if (!isAgentTask && !isTerminal) {
      hasRunningNonAgentTask = true
      const id = typeof obj.id === 'string' ? obj.id.trim() : ''
      if (id.length > 0) {
        runningNonAgentTaskIds.push(id)
        if (runsOrcaOrchestrationWait(obj.command)) {
          runningAgentWaitIds.push(id)
        }
      }
      const command = [obj.command, obj.description].find(
        (text): text is string => typeof text === 'string' && text.trim().length > 0
      )
      if (!runsOrcaOrchestrationWait(obj.command)) {
        // Why: these reach worker status, the CLI and the orchestration DB, so credentials never leave here.
        runningNonAgentTaskCommands.push(command ? redactString(command.trim()) : 'background task')
      }
    }
    if (!isAgentTask) {
      continue
    }
    if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
      truncated = true
      continue
    }
    tasks.push({
      id: obj.id.trim(),
      agentType: typeof obj.agent_type === 'string' ? obj.agent_type : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      running: !isTerminal,
      teammate: taskType === 'teammate'
    })
  }
  return {
    present: true,
    tasks,
    truncated,
    hasRunningNonAgentTask,
    runningNonAgentTaskIds,
    runningAgentWaitIds,
    runningNonAgentTaskCommands
  }
}
