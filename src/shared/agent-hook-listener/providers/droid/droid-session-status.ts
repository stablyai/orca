import {
  continueMainAgentStatus,
  foldAgentLeadStatus
} from '../../../agent-status/lifecycle/agent-lead-status-fold'
import type { AgentLeadStatusResolution } from '../../../agent-status/lifecycle/agent-lead-status-fold'
import type { AgentStatusState } from '../../../agent-status/contracts/agent-status-types'
import { codexRosterChildWorkLiveness, upsertCodexSubagent } from '../codex/codex-subagent-roster'
import type { DroidPaneSessions } from './droid-sessions'

/** How long a row stays working after a background child's Stop, waiting for the lead to wake. */
export const DROID_BACKGROUND_CHILD_LEASE_MS = 10_000

export type DroidNotification = 'permission' | 'idle' | undefined

function showChild(sessions: DroidPaneSessions, id: string, state: 'working' | 'waiting'): void {
  upsertCodexSubagent(
    sessions.roster,
    id,
    { agentType: 'droid', description: `Droid agent ${id.slice(0, 8)}`, state },
    Date.now()
  )
}

/** Applies a child's event to its snapshot. True when the row has something new to say. */
export function applyDroidChildEvent(
  sessions: DroidPaneSessions,
  id: string,
  eventName: unknown,
  notification: DroidNotification,
  needsUserAtToolUse: boolean
): boolean {
  if (needsUserAtToolUse) {
    showChild(sessions, id, 'waiting')
    return true
  }
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    showChild(sessions, id, 'working')
    return true
  }
  if (eventName === 'Notification' && notification === 'permission') {
    showChild(sessions, id, 'waiting')
    return true
  }
  if (eventName === 'Notification' && notification === 'idle') {
    return sessions.roster.delete(id)
  }
  if (eventName !== 'Stop' && eventName !== 'SessionEnd') {
    return false
  }
  const outlivedStop = sessions.children.get(id)?.outlivedStop === true
  const shown = sessions.roster.delete(id)
  sessions.children.delete(id)
  sessions.finished.add(id)
  if (
    outlivedStop &&
    sessions.lead?.state === 'done' &&
    !codexRosterChildWorkLiveness(sessions.roster)
  ) {
    sessions.leaseUntil = Date.now() + DROID_BACKGROUND_CHILD_LEASE_MS
    return true
  }
  return shown
}

/** Moves the lead's own state, and decides which children a Stop or an idle prompt leaves behind. */
export function applyDroidLeadEvent(
  sessions: DroidPaneSessions,
  event: {
    eventName: unknown
    stateName: AgentStatusState
    notification: DroidNotification
  }
): void {
  sessions.lead = continueMainAgentStatus(sessions.lead, { state: event.stateName }, Date.now())
  sessions.leaseUntil = undefined
  if (event.eventName === 'Stop') {
    for (const child of sessions.children.values()) {
      child.outlivedStop = true
    }
  }
  if (event.eventName === 'Notification' && event.notification === 'idle') {
    for (const [id, child] of sessions.children) {
      if (!child.outlivedStop) {
        sessions.roster.delete(id)
        sessions.children.delete(id)
      }
    }
  }
}

/** When the lease on a stopped lead's finished background child runs out; undefined when none runs. */
export function droidBackgroundChildLeaseDeadline(sessions: DroidPaneSessions): number | undefined {
  return codexRosterChildWorkLiveness(sessions.roster) === null ? sessions.leaseUntil : undefined
}

export function resolveDroidRowStatus(
  sessions: DroidPaneSessions,
  now = Date.now()
): AgentLeadStatusResolution {
  const live = codexRosterChildWorkLiveness(sessions.roster)
  const deadline = droidBackgroundChildLeaseDeadline(sessions)
  const leased = deadline !== undefined && deadline > now
  return foldAgentLeadStatus({
    // Why: an unheard confirmed lead is mid-turn; a provisional one may never post here, so only its children count.
    leadState: sessions.lead?.state ?? (sessions.provisional ? 'done' : 'working'),
    childWorkLiveness: leased ? 'working' : live
  })
}
