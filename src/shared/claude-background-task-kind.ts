import type { AgentChildWorkKind } from './agent-status-child-work'

/**
 * The one table of what Claude calls a task. The SDK stream names tasks
 * `local_*`/`monitor`; the hook payload's `background_tasks` inventory names
 * them `subagent`/`teammate`/`shell`/`workflow`, and a hook's launch result
 * names its `taskType` `local_*`. Every lane classifies here so none can
 * drift on which kinds are agents.
 */
export function classifyClaudeBackgroundTaskKind(taskType: unknown): AgentChildWorkKind {
  switch (taskType) {
    case 'local_agent':
    case 'local_subagent':
    case 'subagent':
    case 'teammate':
      return 'agent'
    case 'local_workflow':
    case 'workflow':
      return 'workflow'
    case 'local_bash':
    case 'shell':
    case 'background_shell':
      return 'command'
    case 'monitor':
      return 'monitor'
    default:
      return 'unknown'
  }
}

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
  'stopped',
  'cancelled',
  'canceled',
  'timed_out'
])

/** The one table of the statuses Claude reports for a task that has ended, in its task inventory
 *  and in its task notifications. */
export function isClaudeBackgroundTaskStatusTerminal(status: string): boolean {
  return CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES.has(status)
}
