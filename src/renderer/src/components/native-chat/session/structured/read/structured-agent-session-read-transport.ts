import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { startStructuredAgentSessionLiveRead } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-live-read'
import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import {
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { subscribeStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-subscriptions'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'

type LiveReadArgs = Parameters<typeof startStructuredAgentSessionLiveRead>[0]

// Read once per chat run, overlapping hydration; a host that later refuses the param drops appends.
async function environmentTextAppends(
  environmentId: string
): Promise<AgentSessionTextAppendCapabilities | null> {
  const [textAppend, toolOutputAppend] = await runtimeEnvironmentSupportsCapabilities(
    environmentId,
    [
      AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
      AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
    ]
  ).catch(() => [false, false])
  return agentSessionTextAppendRequest({ textAppend, toolOutputAppend })
}

export function startStructuredAgentSessionReadTransport(
  args: Omit<LiveReadArgs, 'readCurrentRequests' | 'subscribe'> & {
    target: RuntimeClientTarget
  }
): ReturnType<typeof startStructuredAgentSessionLiveRead> {
  const { target, ...read } = args
  return startStructuredAgentSessionLiveRead({
    ...read,
    textAppend:
      target.kind === 'environment'
        ? environmentTextAppends(target.environmentId)
        : ensureLocalRuntimeCapabilities().then((capabilities) =>
            agentSessionTextAppendRequest({
              textAppend:
                capabilities?.includes(AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY) === true,
              toolOutputAppend:
                capabilities?.includes(AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY) === true
            })
          ),
    readCurrentRequests: (request) =>
      callStructuredAgentSession(target, 'agentSession.currentRequests', request),
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(target, params, onEvent, onError, onClose)
  })
}
