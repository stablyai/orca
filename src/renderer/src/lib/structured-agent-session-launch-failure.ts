// The failed start's refusal and host-composed authentication guidance.

import {
  readAgentSessionRefusalReference,
  type AgentSessionRefusalReference
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionConversationOwner } from '../../../shared/agent-session-refusal-details'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteRefusal
} from '../../../shared/agent-session-write-failure'

export type StructuredLaunchFailure = AgentSessionWriteRefusal & {
  authStartupMessage?: string
  owner?: AgentSessionConversationOwner
}

/** The host's refusal behind a failed launch; undefined when the failure carried none. */
export function structuredLaunchFailure(error: unknown): StructuredLaunchFailure | undefined {
  const refusal = launchRefusal(error)
  if (!refusal) {
    return undefined
  }
  const owner =
    refusal.code === 'agent_session_conflict' || refusal.code === 'agent_session_ownership_unknown'
      ? refusal.details?.owner
      : undefined
  const failure = {
    ...agentSessionRefusalFailure(refusal),
    ...(owner ? { owner } : {})
  }
  const message = error instanceof Error ? error.message : undefined
  return failure.code === 'agent_session_operation_invalid' &&
    failure.details?.reason === 'notSignedIn' &&
    message &&
    message !== failure.code
    ? { ...failure, authStartupMessage: message }
    : failure
}

/** The chat a refused takeover names as already holding the conversation: the host's ownership
 *  index, which a write failure does not keep. */
export function structuredLaunchConversationOwner(
  error: unknown
): AgentSessionConversationOwner | undefined {
  const details = launchRefusal(error)?.details
  return details && 'owner' in details ? details.owner : undefined
}

function launchRefusal(error: unknown): AgentSessionRefusalReference | undefined {
  return error instanceof Error && 'refusal' in error
    ? readAgentSessionRefusalReference(error.refusal)
    : readAgentSessionErrorRefusal(error)
}
