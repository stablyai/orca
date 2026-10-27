import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from './agent-session/agent-session-conversation-command'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { StructuredAgentSessionCommandRefusalCause } from './structured-agent-session-composer'

/** Host refusal reasons that map to visible chat conditions. */
const CAUSE_OF_HOST_REFUSAL: Partial<Record<string, StructuredAgentSessionCommandRefusalCause>> = {
  turnActive: 'working',
  messagesUnsettled: 'working',
  promptPending: 'prompt',
  backgroundTasksRunning: 'background'
}

/** Map only fully readable host refusals; other failures have no waiting condition. */
export function structuredAgentSessionCommandHostRefusalCause(
  result: AgentSessionConversationCommandResult
): StructuredAgentSessionCommandRefusalCause | undefined {
  const details = isAgentSessionConversationCommand(result.command)
    ? readWholeAgentSessionFailureFact(result.failure)?.refusal?.details
    : undefined
  return details && 'reason' in details && typeof details.reason === 'string'
    ? CAUSE_OF_HOST_REFUSAL[details.reason]
    : undefined
}
