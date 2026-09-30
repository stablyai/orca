import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import {
  classifyClaudeBackgroundTaskKind,
  isClaudeBackgroundTaskStatusTerminal
} from './claude-background-task-kind'
import { isAgentChildWorkKind } from './agent-status-child-work-liveness'
import type { AgentChildWorkKind } from './agent-status-child-work'

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

/** One running non-agent entry (a shell, a monitor, a workflow) Claude named in its inventory. */
export type ClaudeBackgroundNonAgentTask = { id: string; kind: AgentChildWorkKind }

/** Read the agent-typed entries of a hook payload's `background_tasks` field.
 *  `present: false` means the field was absent/malformed (older Claude builds),
 *  so callers must keep their tracked roster instead of clearing it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
  truncated: boolean
  hasRunningNonAgentTask: boolean
  /** Running non-agent entries with an id, by Claude's task id. */
  runningNonAgentTasks: ClaudeBackgroundNonAgentTask[]
  /** Running non-agent work reported without an id or a type, or as a non-object entry. */
  hasUnnamedRunningNonAgentTask: boolean
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return {
      present: false,
      tasks: [],
      truncated: false,
      hasRunningNonAgentTask: false,
      runningNonAgentTasks: [],
      hasUnnamedRunningNonAgentTask: false
    }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  const runningNonAgentTasks: ClaudeBackgroundNonAgentTask[] = []
  let truncated = false
  let hasUnnamedRunningNonAgentTask = false
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      truncated = true
      hasUnnamedRunningNonAgentTask = true
      continue
    }
    const obj = item as Record<string, unknown>
    const taskType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : ''
    const taskStatus = typeof obj.status === 'string' ? obj.status.trim().toLowerCase() : ''
    const isTerminal = isClaudeBackgroundTaskStatusTerminal(taskStatus)
    if (taskType.length === 0) {
      truncated = true
      hasUnnamedRunningNonAgentTask ||= !isTerminal
      continue
    }
    const kind = classifyClaudeBackgroundTaskKind(taskType)
    const isAgentTask = isAgentChildWorkKind(kind)
    // Why: future non-agent types and nonterminal labels must fail active; only typed agent rows or explicit terminal states can safely retire work.
    if (!isAgentTask && !isTerminal) {
      const id = typeof obj.id === 'string' ? obj.id.trim() : ''
      if (id.length > 0) {
        runningNonAgentTasks.push({ id, kind })
      } else {
        hasUnnamedRunningNonAgentTask = true
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
    hasRunningNonAgentTask: runningNonAgentTasks.length > 0 || hasUnnamedRunningNonAgentTask,
    runningNonAgentTasks,
    hasUnnamedRunningNonAgentTask
  }
}
