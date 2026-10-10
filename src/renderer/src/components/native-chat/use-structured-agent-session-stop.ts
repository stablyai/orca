import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentSessionStopTarget } from '../../../../shared/agent-session-stop-target'
import {
  useStructuredAgentSessionHostCapability,
  useStructuredAgentSessionHostStopsConversation
} from '@/runtime/structured-agent-session-host-capability'
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
    'fence' | 'isWorking' | 'submissions'
  >
  /** The host says a person's Stop is still ending this session's work. */
  hostStopping: boolean
  mutate: StructuredAgentSessionMutate
}): {
  stopping: boolean
  /** This client's Stop request is in flight. */
  pressed: boolean
  /** A host that takes a Stop naming no turn gets Stop from the send until the work settles; every
   *  Stop before a turn opens needs that form. An older host can stop only a turn it has opened. */
  stopsConversation: boolean
  stop: (turnId: string | null, stopSends: () => void) => Promise<unknown>
} {
  const { sessionId, target, transportState, hostStopping, mutate } = input
  const press = useStructuredAgentSessionStopPress(sessionId)
  const targetedStop = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY
  )
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
      const stopTarget = agentSessionStopTarget(
        turnId,
        transportState.submissions,
        transportState.fence
      )
      // The chat's own send goes no further if it has not gone out yet. Host-held cards are
      // never withdrawn by a Stop: the host pauses them, visible on every device, until acted on.
      if (stopsConversation) {
        stopSends()
        return press.track(() =>
          mutate(
            'agentSession.cancel',
            'agentSession.cancel',
            stopTarget && targetedStop ? { stopTarget } : {}
          )
        )
      }
      if (!turnId) {
        return Promise.resolve(null)
      }
      stopSends()
      return press.track(() => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }))
    }
  }
}
