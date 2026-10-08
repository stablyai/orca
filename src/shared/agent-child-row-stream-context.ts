import type { AgentChildRowContext } from './agent-child-row-model'

/** The context a structured session's own stream gives the children it publishes, for a reader
 *  holding no status row for that session (the phone). The host owns the session, so its evidence
 *  never ages out (as a host-owned row's does not); only losing the stream makes a live claim
 *  unverifiable. `hostClockOffsetMs` is reader clock minus host clock. No parent clock: the stream
 *  publishes child views or the task roster, never the `subagents` snapshot that reads one. */
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
