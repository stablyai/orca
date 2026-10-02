// What a failed chat start's Retry line may say: the host's refusal, never its message.

import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteRefusal
} from '../../../shared/agent-session-write-failure'

/** The host's refusal behind a failed launch; undefined when the failure carried none (a lost
 *  reply, a local fault, an older host). Reads a create error's own refusal or an RPC error's. */
export function structuredLaunchFailure(error: unknown): AgentSessionWriteRefusal | undefined {
  const refusal =
    error instanceof Error && 'refusal' in error
      ? readAgentSessionRefusalReference(error.refusal)
      : readAgentSessionErrorRefusal(error)
  return refusal ? agentSessionRefusalFailure(refusal) : undefined
}
