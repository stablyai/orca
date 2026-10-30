// Share desktop/phone status folding so frames and contact loss have the same meaning.

import type { AgentSessionStatusEvent, AgentSessionStatusSummary } from './agent-session-wire'

export type AgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

/** Merge snapshots: restarting hosts restore asynchronously and may first publish empty. Dropping retained rows would flicker; end changes nothing. */
export function foldAgentSessionStatusEvent(
  snapshot: AgentSessionStatusSnapshot,
  event: AgentSessionStatusEvent
): AgentSessionStatusSnapshot {
  if (event.type === 'snapshot') {
    if (event.sessions.length === 0) {
      return snapshot
    }
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
    if (
      !summary.hostExecutionOwned &&
      !summary.stopping &&
      !summary.restartResume &&
      summary.runtimePermission === null
    ) {
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
    next.set(sessionId, {
      ...retained,
      runtimePermission: null
    })
  }
  return next ?? snapshot
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
