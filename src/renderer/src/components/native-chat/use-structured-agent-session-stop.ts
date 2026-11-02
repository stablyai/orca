import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionHostStopsConversation } from '@/runtime/structured-agent-session-host-capability'
import { agentStopDisplayStatus } from '../../../../shared/agent-stop-display-status'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionStopPress } from './use-structured-agent-session-stop-press'
import type { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'

/** This session's Stop: whether the chat reads "Stopping…", and the request itself. */
export function useStructuredAgentSessionStop(input: {
  sessionId: string
  target: RuntimeClientTarget
  transportState: Pick<
    ReturnType<typeof useStructuredAgentSessionTransportState>,
    'fence' | 'isWorking'
  >
  /** The host says a person's Stop is still ending this session's work. */
  hostStopping: boolean
  mutate: StructuredAgentSessionMutate
}): {
  stopping: boolean
  /** This client's Stop request is in flight. */
  pressed: boolean
  /** Untargeted Stop works before a turn opens; older hosts can stop only opened, named turns. */
  stopsConversation: boolean
  stop: (turnId: string | null, stopSends: () => void) => Promise<unknown>
} {
  const { sessionId, target, transportState, hostStopping, mutate } = input
  const press = useStructuredAgentSessionStopPress(sessionId)
  const stopsConversation =
    useStructuredAgentSessionHostStopsConversation(target) && transportState.fence !== null
  return {
    stopping:
      agentStopDisplayStatus({
        working: transportState.isWorking,
        hostStopping,
        stopPressed: press.pressed
      }) === 'stopping',
    pressed: press.pressed,
    stopsConversation,
    stop: (turnId, stopSends) => {
      // Withdraw local unsent work; retain host-held cards for the host to pause visibly across devices.
      if (stopsConversation) {
        stopSends()
        return press.track(() => mutate('agentSession.cancel', 'agentSession.cancel', {}))
      }
      if (!turnId) {
        return Promise.resolve(null)
      }
      stopSends()
      return press.track(() => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }))
    }
  }
}
