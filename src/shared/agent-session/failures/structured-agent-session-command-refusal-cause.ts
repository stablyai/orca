import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../agent-session-conversation-command'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionWriteFailure } from './agent-session-write-failure'
import type { StructuredAgentSessionCommandRefusalCause } from '../view/structured-agent-session-composer'

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

/** The same mapping for a command the host refused outright, before it ran. */
export function structuredAgentSessionCommandWriteRefusalCause(
  failure: AgentSessionWriteFailure
): StructuredAgentSessionCommandRefusalCause | undefined {
  const reason = failure.kind === 'refused' ? failure.details?.reason : undefined
  return typeof reason === 'string' ? CAUSE_OF_HOST_REFUSAL[reason] : undefined
}
