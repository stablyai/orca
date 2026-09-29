import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session-conversation-outline'
import {
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  type RuntimeCapability
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
/** Read a capability through the runtime's existing status cache. A failed/unknown
 *  probe is treated as legacy so a newer call is never made before the host has
 *  proved it understands it. */
async function structuredAgentSessionHostSupports(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): Promise<boolean> {
  try {
    if (target.kind === 'local') {
      const known = readLocalRuntimeCapabilitiesOrUnknown()
      const capabilities = known ?? (await ensureLocalRuntimeCapabilities())
      return capabilities?.includes(capability) === true
    }
    return await runtimeEnvironmentSupportsCapability(target.environmentId, capability)
  } catch {
    return false
  }
}

export function supportsStructuredAgentSessionPromptCancel(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionQuestionAnswers(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY
  )
}

/** Null when the host predates the outline, without calling it. A failed read
 *  rejects, so the caller can retry it; the rail maps loaded messages meanwhile. */
export async function readStructuredAgentSessionConversationOutline(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<AgentSessionConversationOutline | null> {
  if (
    !(await structuredAgentSessionHostSupports(
      target,
      AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return callRuntimeRpc<AgentSessionConversationOutline>(
    target,
    'agentSession.conversationOutline',
    { sessionId }
  )
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
      expectedEnvironmentPairingRevision:
        target.expectedEnvironmentPairingRevision ??
        getRuntimeEnvironmentRevision(target.environmentId)
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

/** Turns that settle from now on. The host sends no snapshot and replays nothing, so a
 *  subscriber that reconnects has missed whatever completed while it was away. */
export function subscribeStructuredAgentSessionTurnCompletions(
  target: RuntimeClientTarget,
  onEvent: (event: AgentSessionTurnCompletionEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribeTurnCompletions',
    {},
    onEvent,
    onError,
    onClose
  )
}
