import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'

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
const CLAUDE_NON_AGENT_TASK_ID_MAX_LENGTH = 128
const CLAUDE_NON_AGENT_TASK_ID_MAX_COUNT = 256

/** One agent entry from the `background_tasks` array Claude attaches to Stop
 *  (and SubagentStop) hook payloads. Non-agent tasks do not become rows. */
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

/** Read the agent-typed entries of a hook payload's `background_tasks` field.
 *  `present: false` means the field was absent/malformed (older Claude builds),
 *  so callers must keep their tracked roster instead of clearing it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
  truncated: boolean
  hasRunningNonAgentTask: boolean
  runningNonAgentTaskIds: string[]
  hasUnidentifiedRunningNonAgentTask: boolean
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return {
      present: false,
      tasks: [],
      truncated: false,
      hasRunningNonAgentTask: false,
      runningNonAgentTaskIds: [],
      hasUnidentifiedRunningNonAgentTask: false
    }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  const runningNonAgentTaskIds: string[] = []
  let truncated = false
  let hasRunningNonAgentTask = false
  let hasUnidentifiedRunningNonAgentTask = false
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      truncated = true
      hasRunningNonAgentTask = true
      hasUnidentifiedRunningNonAgentTask = true
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
      hasUnidentifiedRunningNonAgentTask ||= !isTerminal
      continue
    }
    const isAgentTask = taskType === 'subagent' || taskType === 'teammate'
    // Why: future non-agent types and nonterminal labels must fail active; only typed agent rows or explicit terminal states can safely retire work.
    if (!isAgentTask && !isTerminal) {
      hasRunningNonAgentTask = true
      const taskId = typeof obj.id === 'string' ? obj.id.trim() : ''
      if (
        taskId.length > 0 &&
        taskId.length <= CLAUDE_NON_AGENT_TASK_ID_MAX_LENGTH &&
        runningNonAgentTaskIds.length < CLAUDE_NON_AGENT_TASK_ID_MAX_COUNT
      ) {
        runningNonAgentTaskIds.push(taskId)
      } else {
        hasUnidentifiedRunningNonAgentTask = true
      }
    }
    if (!isAgentTask) {
      continue
    }
    if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
      truncated = true
      continue
    }
    if (tasks.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      // Why: a capped inventory cannot prove a tracked id is absent; callers
      // must retain unlisted rows rather than deleting live overflow tasks.
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
    hasUnidentifiedRunningNonAgentTask
  }
}
