// The failed start's refusal and host-composed authentication guidance.

import type { AgentSessionConversationOwner } from '../../../shared/agent-session-refusal-details'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
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
  const refusal =
    error instanceof Error && 'refusal' in error
      ? readAgentSessionRefusalReference(error.refusal)
      : readAgentSessionErrorRefusal(error)
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
