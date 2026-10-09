import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session-conversation-outline'
import { AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS } from '../../../shared/agent-session-conversation-command'
import {
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY,
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
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
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

/** Whether the host writes no row for a Stop that stopped nothing, so a repeated Stop is quiet. */
export function supportsStructuredAgentSessionQuietRepeatedStop(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY)
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

const STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS: ReadonlyMap<string, number> = new Map([
  ['agentSession.conversationCommand', AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS],
  // The host may start an agent at rest before rewinding it, as it does for a command.
  ['agentSession.rewind', 195_000],
  // A waiting catalog read lasts as long as the host's listing: Claude's is 60 s, after up to 15 s
  // for an account switch to settle and 5 s of login-shell environment.
  ['agentSession.modelCatalog', 90_000]
])

export async function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  /** For a caller that checked the remote host's compatibility itself, just before. */
  options: { skipCompatibilityCheck?: true } = {}
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
  return timeoutMs === undefined && !options.skipCompatibilityCheck
    ? callRuntimeRpc<TResult>(target, method, params)
    : callRuntimeRpc<TResult>(target, method, params, {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...options
      })
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
  return subscribeRuntimeEnvironment(
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

/** The user read this chat: the owning host withdraws the phone alerts it pushed for it. An older
 *  host has no such method and is skipped; a failure is bookkeeping and only logged. */
export async function acknowledgeStructuredAgentSessionAttention(
  target: RuntimeClientTarget,
  sessionId: string,
  observedCursor: AgentJournalCursor
): Promise<boolean> {
  const capturedCursor = { ...observedCursor }
  try {
    if (
      !(await structuredAgentSessionHostSupports(
        target,
        AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
      ))
    ) {
      return false
    }
    const result = await callRuntimeRpc<{ acknowledged: boolean }>(
      target,
      'agentSession.acknowledgeAttention',
      { sessionId, observedCursor: capturedCursor }
    )
    return result.acknowledged
  } catch (error) {
    console.warn('[structured-session-attention] acknowledgement failed', error)
    return false
  }
}

/** Turns that settle, and prompts raised, from now on. The host sends no snapshot and replays
 *  nothing, so a subscriber that reconnects has missed whatever happened while it was away. */
export function subscribeStructuredAgentSessionTurnCompletions(
  target: RuntimeClientTarget,
  onEvent: (event: AgentSessionTurnCompletionEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribeTurnCompletions',
    // An older host ignores this and sends completions only: it raises no prompt alert, as before.
    { includePrompts: true },
    onEvent,
    onError,
    onClose
  )
}
