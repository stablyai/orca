import type { AgentChildWorkKind } from './agent-status-child-work'

/**
 * The one table of what Claude calls a task. The SDK stream names tasks
 * `local_*`/`monitor`; the hook payload's `background_tasks` inventory names
 * them `subagent`/`teammate`/`shell`. Both lanes classify here so neither can
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
