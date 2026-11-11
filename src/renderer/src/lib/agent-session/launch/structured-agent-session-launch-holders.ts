import { launchStateLifecycle } from './structured-agent-session-launch-lifecycle'
import {
  structuredLaunchStates,
  type StructuredLaunchState
} from './structured-agent-session-launch-state-store'
import type { AgentLaunchRequestId } from './routing/agent-launch-request-id'

// Coalesce re-delivery of one action only. Other actions and failed/unconfirmed retries open independent chats/text; conversation resumes still hold because hosts refuse duplicate adoption.
function holdsLaunchIdentity(
  state: StructuredLaunchState,
  requestId?: AgentLaunchRequestId
): boolean {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'failed' || lifecycle === 'cancelled') {
    return false
  }
  // A fork of one response holds like a resume, so a lost reply replays rather than copies again.
  if (state.intent.params.resumeFrom || state.intent.params.forkFrom) {
    return true
  }
  const { attempt } = state.callers
  return (
    (lifecycle !== 'visibility-unknown' ||
      (!!state.intent.params.firstMessage && requestId !== undefined)) &&
    (requestId === undefined ? attempt.kind === 'first' : attempt.requestId === requestId)
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
