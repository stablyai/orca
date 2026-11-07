import { startStructuredAgentSessionLiveRead } from '../../../../../../../shared/agent-session/structured-agent-session-live-read'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { subscribeStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-subscriptions'

type LiveReadArgs = Parameters<typeof startStructuredAgentSessionLiveRead>[0]

export function startStructuredAgentSessionReadTransport(
  args: Omit<LiveReadArgs, 'readCurrentRequests' | 'subscribe'> & {
    target: RuntimeClientTarget
  }
): ReturnType<typeof startStructuredAgentSessionLiveRead> {
  const { target, ...read } = args
  return startStructuredAgentSessionLiveRead({
    ...read,
    readCurrentRequests: (request) =>
      callStructuredAgentSession(target, 'agentSession.currentRequests', request),
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(target, params, onEvent, onError, onClose)
  })
}
