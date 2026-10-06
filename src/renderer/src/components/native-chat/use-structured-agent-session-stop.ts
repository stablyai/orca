import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
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
  /** A host that takes a Stop naming no turn gets Stop from the send until the work settles; every
   *  Stop before a turn opens needs that form. An older host can stop only a turn it has opened. */
  stopsConversation: boolean
  stop: (turnId: string | null, withdrawUnsent: () => void) => Promise<unknown>
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
    stop: (turnId, withdrawUnsent) => {
      if (stopsConversation) {
        // Unsent text this client still owns goes back to its composer — a local move.
        // Host-held drafts are never withdrawn by a Stop: the host pauses them and
        // they stay visible as cards, on every device, until the user acts on one.
        withdrawUnsent()
        return press.track(() => mutate('agentSession.cancel', 'agentSession.cancel', {}))
      }
      return turnId
        ? press.track(() => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }))
        : Promise.resolve(null)
    }
  }
}
