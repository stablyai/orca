// Share desktop/phone status folding so frames and contact loss have the same meaning.

import type { AgentSessionStatusEvent, AgentSessionStatusSummary } from '../agent-session-wire'

export type AgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

/** Summaries an event carries; `end` and other frames carry none. */
function eventSummaries(event: AgentSessionStatusEvent): readonly AgentSessionStatusSummary[] {
  return event.type === 'snapshot' ? event.sessions : event.type === 'status' ? [event.session] : []
}

/** Merge snapshots: restarting hosts restore asynchronously and may first publish empty. Dropping retained rows would flicker; end changes nothing. */
export function foldAgentSessionStatusEvent(
  snapshot: AgentSessionStatusSnapshot,
  event: AgentSessionStatusEvent
): AgentSessionStatusSnapshot {
  if (eventSummaries(event).length === 0) {
    return snapshot
  }
  const next = new Map(snapshot)
  applyAgentSessionStatusEvent(next, event)
  return next
}

/** The same merge on an owned map, returning the sessions it wrote so only their readers are woken. */
export function applyAgentSessionStatusEvent(
  snapshot: Map<string, AgentSessionStatusSummary>,
  event: AgentSessionStatusEvent
): string[] {
  const summaries = eventSummaries(event)
  for (const session of summaries) {
    snapshot.set(session.sessionId, session)
  }
  return summaries.map((session) => session.sessionId)
}

/** Contact loss removes live host execution/Stop claims only; retain everything else because disconnect is no proof of exit. Preserve identity if unchanged. */
export function revokeAgentSessionStatusLive(
  snapshot: AgentSessionStatusSnapshot
): AgentSessionStatusSnapshot {
  let next: Map<string, AgentSessionStatusSummary> | null = null
  for (const [sessionId, summary] of snapshot) {
    const revoked = revokedLiveSummary(summary)
    if (revoked) {
      next ??= new Map(snapshot)
      next.set(sessionId, revoked)
    }
  }
  return next ?? snapshot
}

/** The same revocation on an owned map, returning the sessions it changed. */
export function revokeAgentSessionStatusLiveInPlace(
  snapshot: Map<string, AgentSessionStatusSummary>
): string[] {
  const changed: string[] = []
  for (const [sessionId, summary] of snapshot) {
    const revoked = revokedLiveSummary(summary)
    if (revoked) {
      snapshot.set(sessionId, revoked)
      changed.push(sessionId)
    }
  }
  return changed
}

function revokedLiveSummary(summary: AgentSessionStatusSummary): AgentSessionStatusSummary | null {
  if (
    !summary.hostExecutionOwned &&
    !summary.stopping &&
    !summary.restartResume &&
    summary.runtimePermission === null
  ) {
    return null
  }
  const {
    hostExecutionOwned: _owned,
    hostExecutionPhase: _phase,
    stopping: _stopping,
    restartResume: _restartResume,
    ...retained
  } = summary
  return { ...retained, runtimePermission: null }
}

/** A provider head is a query dependency, never a client-side ownership index. */
export class AgentSessionAssociationObservation {
  private readonly associations = new Map<string, string>()
  private confirmed = false
  revision = 0

  renew(): void {
    this.confirmed = false
  }

  observe(frame: unknown): boolean {
    if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
      return false
    }
    let included: unknown[]
    if (frame.type === 'snapshot' && 'sessions' in frame && Array.isArray(frame.sessions)) {
      if ('namingActiveSessionIds' in frame) {
        return false
      }
      included = frame.sessions
    } else if (frame.type === 'status' && 'session' in frame) {
      included = [frame.session]
    } else {
      return false
    }
    let changed = frame.type === 'snapshot' && !this.confirmed
    for (const summary of included) {
      if (
        typeof summary !== 'object' ||
        summary === null ||
        !('sessionId' in summary) ||
        typeof summary.sessionId !== 'string' ||
        !('agent' in summary) ||
        typeof summary.agent !== 'string' ||
        !('workspaceId' in summary) ||
        typeof summary.workspaceId !== 'string'
      ) {
        continue
      }
      const provider = 'providerSession' in summary ? summary.providerSession : undefined
      if (
        provider !== undefined &&
        (typeof provider !== 'object' ||
          provider === null ||
          !('key' in provider) ||
          typeof provider.key !== 'string' ||
          !('id' in provider) ||
          typeof provider.id !== 'string')
      ) {
        continue
      }
      const tuple = JSON.stringify([
        summary.agent,
        summary.workspaceId,
        provider?.key,
        provider?.id
      ])
      changed ||= this.associations.get(summary.sessionId) !== tuple
      this.associations.set(summary.sessionId, tuple)
    }
    if (frame.type === 'snapshot') {
      this.confirmed = true
    }
    if (changed) {
      this.revision += 1
    }
    return changed
  }
}
