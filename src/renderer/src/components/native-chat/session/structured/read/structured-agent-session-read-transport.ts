import { startStructuredAgentSessionLiveRead } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-live-read'
import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import {
  AGENT_SESSION_LIVE_TEXT_VIEWER_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_SUGGESTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { subscribeStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-subscriptions'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { documentLiveTextViewer, documentViewerVisibility } from './document-viewer-visibility'

type LiveReadArgs = Parameters<typeof startStructuredAgentSessionLiveRead>[0]

const LOCAL_TEXT_APPEND: AgentSessionTextAppendCapabilities = { textAppend: 1, toolOutputAppend: 1 }

// Read once per chat run, overlapping hydration; a host that later refuses the param drops what
// it asked for. Older hosts' params predate each key, and a failed check asks for none.
function environmentSubscribeAsks(environmentId: string): {
  textAppend: Promise<AgentSessionTextAppendCapabilities | null>
  promptSuggestions: Promise<boolean>
  liveTextViewer: Promise<boolean>
} {
  const supported = runtimeEnvironmentSupportsCapabilities(environmentId, [
    AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
    AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY,
    AGENT_SESSION_PROMPT_SUGGESTIONS_RUNTIME_CAPABILITY,
    AGENT_SESSION_LIVE_TEXT_VIEWER_RUNTIME_CAPABILITY
  ]).catch(() => [false, false, false, false])
  return {
    textAppend: supported.then(([textAppend, toolOutputAppend]) =>
      agentSessionTextAppendRequest({ textAppend, toolOutputAppend })
    ),
    promptSuggestions: supported.then(([, , promptSuggestions]) => promptSuggestions === true),
    liveTextViewer: supported.then(([, , , liveTextViewer]) => liveTextViewer === true)
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
  const asks = target.kind === 'environment' ? environmentSubscribeAsks(target.environmentId) : null
  const viewer = asks?.liveTextViewer ?? true
  let sendsShownTail = viewer === true
  void Promise.resolve(viewer).then((supported) => (sendsShownTail = supported))
  return startStructuredAgentSessionLiveRead({
    ...read,
    // A streaming reply goes out as its new text every window. The local host ships with this
    // renderer, so it is asked without a check and the read still opens in the same turn.
    textAppend: asks ? asks.textAppend : LOCAL_TEXT_APPEND,
    ...(showsPromptSuggestions ? { promptSuggestions: asks?.promptSuggestions ?? true } : {}),
    coalesce: { visibility: documentViewerVisibility(read.sessionId, () => sendsShownTail) },
    // Only a shown window takes live text; a hidden one gets saves, and the newest text on show.
    liveTextViewer: documentLiveTextViewer(viewer, (viewerId, shown) =>
      callStructuredAgentSession(target, 'agentSession.liveTextShown', {
        sessionId: read.sessionId,
        viewerId,
        shown
      })
    ),
    readCurrentRequests: (request) =>
      callStructuredAgentSession(target, 'agentSession.currentRequests', request),
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(target, params, onEvent, onError, onClose)
  })
}
