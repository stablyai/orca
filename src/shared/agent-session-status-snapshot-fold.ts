// A client's mirror of the host's status feed: the latest summary per session. The desktop and
// the phone fold the stream with these, so they agree on what a frame changes and on what losing
// contact takes away.

import type { AgentSessionStatusEvent, AgentSessionStatusSummary } from './agent-session-wire'

export type AgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

/** The mirror after one frame; `end` leaves it as it is. A snapshot merges over what is held: a
 *  restarted host restores its readable sessions asynchronously, so its first snapshot can be
 *  empty, and dropping those rows would flicker every one to no status. */
export function foldAgentSessionStatusEvent(
  snapshot: AgentSessionStatusSnapshot,
  event: AgentSessionStatusEvent
): AgentSessionStatusSnapshot {
  if (event.type === 'snapshot') {
    const next = new Map(snapshot)
    for (const session of event.sessions) {
      next.set(session.sessionId, session)
    }
    return next
  }
  if (event.type === 'status') {
    const next = new Map(snapshot)
    next.set(event.session.sessionId, event.session)
    return next
  }
  return snapshot
}

/** With contact lost, what only a live host vouches for goes: its execution, and a Stop it was
 *  ending. The rest is kept, since losing contact is never exit. `snapshot` itself if unchanged. */
export function revokeAgentSessionStatusLive(
  snapshot: AgentSessionStatusSnapshot
): AgentSessionStatusSnapshot {
  let next: Map<string, AgentSessionStatusSummary> | null = null
  for (const [sessionId, summary] of snapshot) {
    if (!summary.hostExecutionOwned && !summary.stopping && !summary.restartResume) {
      continue
    }
    next ??= new Map(snapshot)
    const {
      hostExecutionOwned: _owned,
      hostExecutionPhase: _phase,
      stopping: _stopping,
      restartResume: _restartResume,
      ...retained
    } = summary
    next.set(sessionId, retained)
  }
  return next ?? snapshot
}
