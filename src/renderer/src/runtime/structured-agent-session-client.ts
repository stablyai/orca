import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session/agent-session-conversation-outline'
import { AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS } from '../../../shared/agent-session/agent-session-conversation-command'
import {
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import {
  AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY
} from '../../../shared/agent-session-create-capabilities'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
/** Read a capability through the runtime's existing status cache. A failed/unknown
 *  probe is treated as legacy so a newer call is never made before the host has
 *  proved it understands it. */
export async function structuredAgentSessionHostSupports(
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

export function supportsStructuredAgentSessionContinuationContext(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY
  )
}

export function supportsStructuredAgentSessionPromptCancel(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionCreateOptionsMode(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY
  )
}

export function supportsStructuredAgentSessionCreateMessage(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionCliSource(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY
  )
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

export function supportsStructuredAgentSessionItemDetail(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)
}

/** One item whole, as the host keeps it; null when the host no longer has it. Call only after
 *  `supportsStructuredAgentSessionItemDetail`; a failed read rejects. */
export async function readStructuredAgentSessionItem(
  target: RuntimeClientTarget,
  sessionId: string,
  itemId: string
): Promise<AgentJournalRenderItem | null> {
  const result = await callRuntimeRpc<{ item: AgentJournalRenderItem | null }>(
    target,
    'agentSession.item',
    { sessionId, itemId }
  )
  return result?.item ?? null
}

const STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS: ReadonlyMap<string, number> = new Map([
  ['agentSession.conversationCommand', AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS],
  // The host may start an agent at rest before rewinding it, as it does for a command.
  ['agentSession.rewind', 195_000],
  // Waiting model catalogs can take Claude’s 60s listing plus 15s account switch and 5s login environment.
  ['agentSession.modelCatalog', 90_000],
  ['agentSession.sleepWorkspace', 120_000],
  // All bounded-concurrency provider starts and dispatch settlements precede the reply.
  ['agentSession.restartContinue', 600_000]
])

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

async function subscribeStructuredAgentSessionMethod<TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeRuntimeRpc(target, method, params, {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the method whose frames are TEvent; unchecked as before.
    onEvent: (result) => onEvent(result as TEvent),
    onError,
    onClose
  })
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

export function supportsStructuredAgentSessionRegenerateName(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY
  )
}

/** Whether the owning host saves a chat's rename; an unproven host keeps it on the tab. */
export function supportsStructuredAgentSessionRename(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY
  )
}

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
