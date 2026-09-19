import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
/** Read the prompt-cancel capability through the runtime's existing status cache.
 *  A failed/unknown probe is treated as legacy so strict prompt fields are never
 *  sent before the host has proved it understands them. */
export async function supportsStructuredAgentSessionPromptCancel(
  target: RuntimeClientTarget
): Promise<boolean> {
  try {
    if (target.kind === 'local') {
      const known = readLocalRuntimeCapabilitiesOrUnknown()
      const capabilities = known ?? (await ensureLocalRuntimeCapabilities())
      return capabilities?.includes(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY) === true
    }
    return await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY
    )
  } catch {
    return false
  }
}

export async function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
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
  return method === 'agentSession.conversationCommand'
    ? callRuntimeRpc<TResult>(target, method, params, { timeoutMs: 195_000 })
    : callRuntimeRpc<TResult>(target, method, params)
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

/** Root turns settling on one runtime from now on. Raw because the caller validates: an event
 *  this build cannot place must be dropped rather than handed on as a completion. */
export function subscribeStructuredAgentSessionTurnCompletion(
  target: RuntimeClientTarget,
  onEvent: (event: unknown) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribeTurnCompletion',
    {},
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
