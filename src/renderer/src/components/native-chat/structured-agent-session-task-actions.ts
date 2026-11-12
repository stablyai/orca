import type { AgentSessionCancelResult } from '../../../../shared/agent-session/agent-session-wire'
import type {
  AgentSessionForegroundTask,
  AgentSessionBackgroundResult
} from '../../../../shared/agent-session/agent-session-foreground-task'
import type { StructuredAgentSessionMutate } from './session/structured/writes/use-structured-agent-session-mutate'

export function structuredAgentSessionTaskActions(mutate: StructuredAgentSessionMutate) {
  return {
    stopBackgroundTask: (taskId?: string) =>
      mutate<AgentSessionCancelResult>('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    backgroundTask: (target: AgentSessionForegroundTask) =>
      mutate<AgentSessionBackgroundResult>(
        'agentSession.backgroundTask',
        'agentSession.backgroundTask',
        { target }
      )
  }
}
