// Share desktop/phone status folding so frames and contact loss have the same meaning.

import type { AgentSessionStatusEvent, AgentSessionStatusSummary } from './agent-session-wire'

export type AgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

/** Merge snapshots: restarting hosts restore asynchronously and may first publish empty. Dropping retained rows would flicker; end changes nothing. */
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

/** Contact loss removes live host execution/Stop claims only; retain everything else because disconnect is no proof of exit. Preserve identity if unchanged. */
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
