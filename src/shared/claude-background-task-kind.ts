import type { AgentChildWorkKind } from './agent-status-child-work'

/**
 * The one table of what Claude calls a task. The SDK stream names tasks by raw
 * discriminant (`local_*`, `monitor_mcp`, `monitor_ws`); the hook payload's
 * `background_tasks` inventory names them by friendly label (`subagent`,
 * `workflow`, `shell`, `monitor`). Both lanes classify here so neither can
 * drift on which kinds are agents or watch loops.
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
    case 'monitor_mcp':
    case 'monitor_ws':
      return 'monitor'
    default:
      return 'unknown'
  }
}
