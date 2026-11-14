import '../../../../../shared/agent-session/agent-session-attention-capabilities'
import '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-capabilities'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import '../../rpc/compatibility/runtime-capability-proof'
import '../../hosts/capabilities/local-runtime-capabilities'
import '../../rpc/subscriptions/runtime-rpc-subscribe'
import '../requests/structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** Asks the owning host to name the chat again; the status feed carries the outcome. */
export async function regenerateStructuredAgentSessionName(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<boolean> {
  try {
    const result = await callRuntimeRpc<{ accepted: boolean }>(
      target,
      'agentSession.regenerateName',
      { sessionId }
    )
    return result.accepted
  } catch (error) {
    console.warn('[structured-session-naming] regenerate failed', error)
    return false
  }
}
