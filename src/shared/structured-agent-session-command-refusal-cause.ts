import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from './agent-session-conversation-command'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { StructuredAgentSessionCommandRefusalCause } from './structured-agent-session-composer'

/** The host's refusal reasons whose words name something a chat shows. */
const CAUSE_OF_HOST_REFUSAL: Partial<Record<string, StructuredAgentSessionCommandRefusalCause>> = {
  turnActive: 'working',
  messagesUnsettled: 'working',
  promptPending: 'prompt',
  backgroundTasksRunning: 'background'
}

/** What a host's refusal of a command waits on, as a chat shows it; undefined for any other
 *  failure, or one this build can't read whole. */
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
