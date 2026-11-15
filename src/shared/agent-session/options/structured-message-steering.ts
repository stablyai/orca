import type { AgentSessionSteerFallback } from '../requests/agent-session-queued-message-wire'
import type { AgentSessionExecutionOptions } from './protocol/agent-session-execution-options'
import {
  structuredMessageSteeringOptionsDiffer,
  type StructuredMessageSteeringInputs
} from './codex-message-compiler'

export function structuredMessageSteeringUnavailable(
  canInject: boolean,
  input: StructuredMessageSteeringInputs
): AgentSessionSteerFallback | null {
  if (!canInject) {
    return 'provider-queue-only'
  }
  return input.kind === 'codex' && input.steeringSupported === false ? 'codex-legacy' : null
}

export function structuredMessageSteeringFallback(
  canInject: boolean,
  input: StructuredMessageSteeringInputs,
  options: AgentSessionExecutionOptions | undefined
): AgentSessionSteerFallback | null {
  return (
    structuredMessageSteeringUnavailable(canInject, input) ??
    (structuredMessageSteeringOptionsDiffer(input, options) ? 'codex-options' : null)
  )
}
