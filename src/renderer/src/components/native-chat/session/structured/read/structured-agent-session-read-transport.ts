import { startStructuredAgentSessionLiveRead } from '../../../../../../../shared/agent-session/structured-agent-session-live-read'
import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../../../shared/agent-session/agent-session-text-append'
import {
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
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
    // Only a network hop pays for whole-reply restatements; local IPC keeps opening in the same turn.
    ...(target.kind === 'environment'
      ? { textAppend: environmentTextAppends(target.environmentId) }
      : {}),
    readCurrentRequests: (request) =>
      callStructuredAgentSession(target, 'agentSession.currentRequests', request),
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(target, params, onEvent, onError, onClose)
  })
}
