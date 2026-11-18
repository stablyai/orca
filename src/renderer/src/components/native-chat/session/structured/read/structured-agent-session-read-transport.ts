import { startStructuredAgentSessionLiveRead } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-live-read'
import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import {
  AGENT_SESSION_PROMPT_SUGGESTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { subscribeStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-subscriptions'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'

type LiveReadArgs = Parameters<typeof startStructuredAgentSessionLiveRead>[0]

// Read once per chat run, overlapping hydration; a host that later refuses the param drops what
// it asked for. Older hosts' params predate each key, and a failed check asks for none.
function environmentSubscribeAsks(environmentId: string): {
  textAppend: Promise<AgentSessionTextAppendCapabilities | null>
  promptSuggestions: Promise<boolean>
} {
  const supported = runtimeEnvironmentSupportsCapabilities(environmentId, [
    AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
    AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY,
    AGENT_SESSION_PROMPT_SUGGESTIONS_RUNTIME_CAPABILITY
  ]).catch(() => [false, false, false])
  return {
    textAppend: supported.then(([textAppend, toolOutputAppend]) =>
      agentSessionTextAppendRequest({ textAppend, toolOutputAppend })
    ),
    promptSuggestions: supported.then(([, , promptSuggestions]) => promptSuggestions === true)
  }
}

export function startStructuredAgentSessionReadTransport(
  args: Omit<LiveReadArgs, 'readCurrentRequests' | 'subscribe' | 'promptSuggestions'> & {
    target: RuntimeClientTarget
    /** This reader shows prompt suggestions, so the host should generate them while it reads. */
    showsPromptSuggestions?: boolean
  }
): ReturnType<typeof startStructuredAgentSessionLiveRead> {
  const { target, showsPromptSuggestions, ...read } = args
  // Only a network hop pays for whole-reply restatements; local IPC keeps opening in the same turn.
  const asks = target.kind === 'environment' ? environmentSubscribeAsks(target.environmentId) : null
  return startStructuredAgentSessionLiveRead({
    ...read,
    ...(asks ? { textAppend: asks.textAppend } : {}),
    ...(showsPromptSuggestions ? { promptSuggestions: asks?.promptSuggestions ?? true } : {}),
    readCurrentRequests: (request) =>
      callStructuredAgentSession(target, 'agentSession.currentRequests', request),
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(target, params, onEvent, onError, onClose)
  })
}
