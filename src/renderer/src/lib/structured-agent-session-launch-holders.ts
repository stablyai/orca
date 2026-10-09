import {
  launchStateLifecycle,
  structuredLaunchStates,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import type { AgentLaunchRequestId } from './agent-launch-request-id'

// Why: coalescing stops one user action delivered twice racing into two chats. Any other action, a
// failed or unconfirmed launch, or a Retry/re-check of one is not that race: a new start opens a new
// chat carrying its own text. A resume keeps holding: the host refuses a second adoption.
function holdsLaunchIdentity(
  state: StructuredLaunchState,
  requestId?: AgentLaunchRequestId
): boolean {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'failed' || lifecycle === 'cancelled') {
    return false
  }
  if (state.intent.params.resumeFrom) {
    return true
  }
  const { attempt } = state.callers
  return (
    lifecycle !== 'visibility-unknown' &&
    attempt.kind === 'first' &&
    (requestId === undefined || attempt.requestId === requestId)
  )
}

/** Launches a start of `requestId` would join; without it, every new start's own create. */
export function structuredLaunchesHoldingIdentity(
  matches: (identity: string) => boolean,
  requestId?: AgentLaunchRequestId
): StructuredLaunchState[] {
  return [...structuredLaunchStates()].filter(
    (state) => matches(state.identity) && holdsLaunchIdentity(state, requestId)
  )
}

/** The launch a start joins: the one `requestId` re-delivers, or a resume of its conversation. */
export function getJoinableStructuredLaunchState(
  identity: string,
  requestId: AgentLaunchRequestId
): StructuredLaunchState | undefined {
  return structuredLaunchesHoldingIdentity((candidate) => candidate === identity, requestId).at(-1)
}
