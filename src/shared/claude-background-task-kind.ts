import type { AgentChildWorkKind } from './agent-status-child-work'

/** Share SDK local_agent/local_bash/monitor and hook subagent/teammate/shell classification so both lanes agree which tasks are agents. */
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
