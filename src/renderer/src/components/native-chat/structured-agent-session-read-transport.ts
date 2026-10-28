import { startStructuredAgentSessionLiveRead } from '../../../../shared/structured-agent-session-live-read'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  callStructuredAgentSession,
  subscribeStructuredAgentSession
} from '@/runtime/structured-agent-session-client'

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
