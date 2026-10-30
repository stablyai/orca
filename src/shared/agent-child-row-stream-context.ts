import type { AgentChildRowContext } from './agent-child-row-model'

/** Session streams (including mobile) keep host-owned evidence fresh until disconnect. Convert stamps with reader-minus-host offset; no parent clock is needed because streams publish views/task rosters, not legacy subagents. */
export function agentChildRowContextForSessionStream(
  streamLive: boolean,
  hostClockOffsetMs: number
): AgentChildRowContext {
  return {
    parentEvidenceFresh: true,
    transportObservation: streamLive ? 'live' : 'unverifiable',
    parentObservedAt: 0,
    hostClockOffsetMs
  }
}
