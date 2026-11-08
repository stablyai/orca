import '../../../../../shared/agent-session/agent-session-attention-capabilities'
import { AGENT_SESSION_REWIND_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../../../shared/agent-session/lifecycle/agent-session-stop-capabilities'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import '../../hosts/capabilities/local-runtime-capabilities'
import '../../rpc/subscriptions/runtime-rpc-subscribe'
import { STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS } from './structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

export async function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  /** For a caller that checked the remote host's compatibility itself, just before. */
  options: {
    skipCompatibilityCheck?: true
    beforeSend?: () => void
    expectedEnvironmentPairingRevision?: number
  } = {}
): Promise<TResult> {
  if (
    method === 'agentSession.rewind' &&
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    ))
  ) {
    throw new Error('Rewinding requires a newer Orca server. Update the server and try again.')
  }
  const timeoutMs = STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS.get(method)
  return timeoutMs === undefined && Object.keys(options).length === 0
    ? callRuntimeRpc<TResult>(target, method, params)
    : callRuntimeRpc<TResult>(target, method, params, {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...options
      })
}
