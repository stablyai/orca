import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

export function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
): Promise<TResult> {
  return callRuntimeRpc<TResult>(target, method, params)
}

async function subscribeStructuredAgentSessionMethod<TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      onError(response.error)
      return
    }
    onEvent(response.result as TEvent)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method, params }, onResponse)
  }
  return window.api.runtimeEnvironments.subscribe(
    {
      selector: target.environmentId,
      method,
      params,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
    },
    { onResponse, onError, onClose }
  )
}

export function subscribeStructuredAgentSession(
  target: RuntimeClientTarget,
  params: unknown,
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribe',
    params,
    onEvent,
    onError,
    onClose
  )
}

/** Every structured session's projected status on one runtime, as the host publishes it. */
export function subscribeStructuredAgentSessionStatus(
  target: RuntimeClientTarget,
  onEvent: (event: AgentSessionStatusEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribeStatus',
    {},
    onEvent,
    onError,
    onClose
  )
}
