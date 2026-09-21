import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasRuntimeWorkingSubagent,
  claudeTeammateIdMatchesName,
  idleClaudeTeammateByName,
  stopClaudeSubagent,
  upsertWorkingClaudeSubagent
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import {
  clearClaudePendingWaitForAgent,
  getOrCreateClaudeSubagentRoster,
  resolveClaudePaneStatus
} from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

/** SubagentStart/Stop/TeammateIdle update the roster and re-emit the lead's last known state with the fresh child list, so the sidebar reflects spawn/finish even when a background child outlives the lead turn with no other hook traffic. */
export function normalizeClaudeSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop' | 'TeammateIdle',
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const lifecycleField = eventName === 'TeammateIdle' ? 'teammate_name' : 'agent_id'
  const lifecycleId = readString(hookPayload, lifecycleField)
  if (!lifecycleId) {
    return null
  }
  const cachedLead = state.claudeLeadStateByPaneKey.get(paneKey)
  const ownsUnbackedWait =
    cachedLead?.state === 'waiting' &&
    cachedLead.stateBeforeWait === undefined &&
    cachedLead.waitingAgentId !== undefined &&
    (eventName === 'TeammateIdle'
      ? claudeTeammateIdMatchesName(cachedLead.waitingAgentId, lifecycleId)
      : cachedLead.waitingAgentId === lifecycleId)
  const hasCachedLeadEvidence = cachedLead !== undefined && !ownsUnbackedWait
  let roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  let endedChildWork = false
  let endedRuntimeChildWork = false
  if (eventName === 'TeammateIdle') {
    const teammateName = lifecycleId
    // Why: on claude 2.1.21x teammates are turn-based — TeammateIdle means "turn over, awaiting mail", not finished. The row parks as idle (confirmed teammate) instead of leaving, so the sidebar keeps showing resumable children.
    if (roster) {
      let wasWorking = false
      for (const [id, tracked] of roster) {
        if (tracked.state === 'working' && claudeTeammateIdMatchesName(id, teammateName)) {
          wasWorking = true
          endedRuntimeChildWork ||= tracked.restoredFromSnapshot !== true
        }
      }
      idleClaudeTeammateByName(roster, teammateName)
      endedChildWork = wasWorking
    }
    clearClaudePendingWaitForAgent(state, paneKey, (waitingAgentId) =>
      claudeTeammateIdMatchesName(waitingAgentId, teammateName)
    )
  } else {
    const agentId = lifecycleId
    if (eventName === 'SubagentStart') {
      roster = getOrCreateClaudeSubagentRoster(state, paneKey)
      upsertWorkingClaudeSubagent(
        roster,
        agentId,
        { agentType: readString(hookPayload, 'agent_type') },
        Date.now()
      )
    } else {
      if (roster) {
        const tracked = roster.get(agentId)
        const wasWorking = tracked?.state === 'working'
        endedRuntimeChildWork = wasWorking && tracked.restoredFromSnapshot !== true
        // Why: one-shot stops are true finishes (row removed); teammate-shaped stops are turn ends on 2.1.21x — the row parks idle and a later SubagentStart revives it.
        stopClaudeSubagent(roster, agentId)
        endedChildWork = wasWorking && roster.get(agentId)?.state !== 'working'
      }
      // Why: a blocked child that dies without another tool event would pin its permission/question wait on the pane forever — nothing else references that agent again.
      clearClaudePendingWaitForAgent(state, paneKey, (waitingAgentId) => waitingAgentId === agentId)
    }
  }
  const workingChildEvidence = claudeRosterHasRuntimeWorkingSubagent(roster)
  const hasUnconfirmedChild = claudeRosterHasRestoredSnapshotSubagent(roster)
  const hasConfirmedDoneGate =
    cachedLead?.state === 'done' &&
    cachedLead.interrupted !== true &&
    (state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
      state.claudeActiveSessionCronPaneKeys.has(paneKey))
  const restoredOnlyDoneGate =
    cachedLead?.state === 'done' && !hasConfirmedDoneGate && hasUnconfirmedChild
  if (roster?.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  if (
    !workingChildEvidence &&
    (restoredOnlyDoneGate ||
      (endedChildWork && !hasCachedLeadEvidence && (hasUnconfirmedChild || !endedRuntimeChildWork)))
  ) {
    // Why: a restored-only ending proves no lead boundary, and an unmatched restored sibling proves no current liveness; persist the roster transition without publishing fresh work or completion.
    state.claudeUnconfirmedRestoredStatusPaneKeys.add(paneKey)
  }
  return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
    workingChildEvidence,
    endedChildWork,
    endedRuntimeChildWork
  })
}
/** Re-emit the cached lead state without touching its tool/prompt caches; child churn and parallel completions must not dismiss live cards. */
export function buildClaudeCachedLeadStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  evidence: {
    workingChildEvidence?: boolean
    endedChildWork?: boolean
    endedRuntimeChildWork?: boolean
  } = {}
): ParsedAgentStatusPayload | null {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  let leadState = lead?.state
  if (!leadState) {
    if (evidence.workingChildEvidence || evidence.endedRuntimeChildWork) {
      // Why: ending a current-runtime child wakes its parent; only a cached lead boundary can prove the whole pane completed.
      leadState = 'working'
    } else if (evidence.endedChildWork) {
      // Why: a restored child ending proves only that child ended; persist its roster transition as unconfirmed working, never as lead completion.
      leadState = 'working'
    } else {
      return null
    }
  }
  return buildClaudeStatusPayload(state, eventName, '', paneKey, hookPayload, {
    ...resolveClaudePaneStatus(state, paneKey, {
      state: leadState,
      interrupted: lead?.interrupted
    }),
    updateToolSnapshot: false,
    interrupted: lead?.interrupted,
    // Why: draining the last background child is this turn's all-clear; the stamp lets a consumer pair it with the announcement already sent.
    turnCompletedAt: lead?.turnCompletedAt
  })
}
