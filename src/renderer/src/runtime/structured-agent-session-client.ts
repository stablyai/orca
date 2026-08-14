import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

export function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
): Promise<TResult> {
  return callRuntimeRpc<TResult>(target, method, params)
}

export async function subscribeStructuredAgentSession(
  target: RuntimeClientTarget,
  params: unknown,
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      onError(response.error)
      return
    }
    onEvent(response.result as AgentSessionSubscribeEvent)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method: 'agentSession.subscribe', params }, onResponse)
  }
  return window.api.runtimeEnvironments.subscribe(
    {
      selector: target.environmentId,
      method: 'agentSession.subscribe',
      params,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
    },
    { onResponse, onError, onClose }
  )
}
