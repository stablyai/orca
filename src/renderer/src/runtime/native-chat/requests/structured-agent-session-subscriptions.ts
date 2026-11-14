import '../../../../../shared/agent-session/agent-session-attention-capabilities'
import '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../../../shared/agent-session/lifecycle/agent-session-stop-capabilities'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import '../../rpc/calls/runtime-rpc-call'
import '../../rpc/compatibility/runtime-capability-proof'
import '../../hosts/capabilities/local-runtime-capabilities'
import { subscribeRuntimeRpc } from '../../rpc/subscriptions/runtime-rpc-subscribe'
import './structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionStatusEvent
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { AgentSessionVoiceEvent } from '../../../../../shared/agent-session/agent-session-voice-conversation'

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

/** One Codex voice attempt; unsubscribing stops the provider's voice session. */
export function subscribeStructuredAgentSessionVoice(
  target: RuntimeClientTarget,
  params: { sessionId: string; offerSdp: string; voice?: string },
  onEvent: (event: AgentSessionVoiceEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.voiceConversation',
    params,
    onEvent,
    onError,
    onClose
  )
}
