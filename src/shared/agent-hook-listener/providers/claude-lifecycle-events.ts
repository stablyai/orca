import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  markClaudeBackgroundAgentRunning,
  oweClaudeAgentTaskNotification,
  recordClaudeUnconfirmedAgentEnd
} from '../../claude-owed-task-notifications'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasRuntimeWorkingSubagent,
  claudeTeammateIdMatchesName,
  idleClaudeTeammateByName,
  stopClaudeSubagent,
  upsertWorkingClaudeSubagent
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { claudeRowHasUnlistedLiveWork } from './claude-pane-hold-evidence'
import { readString } from '../tool-input-preview'
import {
  clearClaudePendingWaitForAgent,
  getOrCreateClaudeSubagentRoster,
  resolveClaudePaneStatus
} from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

/** Child lifecycle updates roster and re-emits cached lead state when children outlive its turn; child StopFailure ends a turn like SubagentStop. */
export function normalizeClaudeSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop' | 'StopFailure' | 'TeammateIdle',
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const lifecycleField = eventName === 'TeammateIdle' ? 'teammate_name' : 'agent_id'
  const lifecycleId = readString(hookPayload, lifecycleField)
  if (!lifecycleId) {
    return null
  }
  const sessionOwner = state.claudeSessionOwnerByPaneKey.get(paneKey)
  const currentSession =
    sessionOwner !== undefined && sessionOwner === readString(hookPayload, 'session_id')
  const compatibleSession = sessionOwner === undefined || currentSession
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
    // Claude2.1.21x teammate idle ends a turn, not its lifetime; retain resumable rows.
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
      if (compatibleSession) {
        markClaudeBackgroundAgentRunning(
          state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
          agentId
        )
      }
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
        // One-shots finish; teammate stops park idle until another SubagentStart.
        stopClaudeSubagent(roster, agentId)
        endedChildWork = wasWorking && roster.get(agentId)?.state !== 'working'
      }
      // The roster distinguishes finished tasks from idle teammates.
      if (compatibleSession && roster?.get(agentId)?.state !== 'idle') {
        const tasks = state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey) ?? new Map()
        if (currentSession && endedRuntimeChildWork) {
          recordClaudeUnconfirmedAgentEnd(tasks, agentId, Date.now())
          state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, tasks)
        }
        oweClaudeAgentTaskNotification(tasks, agentId, Date.now())
      }
      // An ended blocked child must release its otherwise permanent wait.
      clearClaudePendingWaitForAgent(state, paneKey, (waitingAgentId) => waitingAgentId === agentId)
    }
  }
  const workingChildEvidence = claudeRosterHasRuntimeWorkingSubagent(roster)
  const hasUnconfirmedChild = claudeRosterHasRestoredSnapshotSubagent(roster)
  // Confirmed shell/cron/owed-notification evidence survives every lead verdict.
  const hasConfirmedDoneGate =
    cachedLead?.state === 'done' && claudeRowHasUnlistedLiveWork(state, paneKey)
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
    // Restored-only endings prove no lead completion or sibling liveness; persist without inventing fresh work.
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
      // Current-runtime child endings wake the parent; only cached lead boundaries can prove pane completion.
      leadState = 'working'
    } else if (evidence.endedChildWork) {
      // Snapshot child endings prove only that child ended, never lead completion.
      leadState = 'working'
    } else {
      return null
    }
  }
  // Repeat the turn stamp on all-clear so consumers pair it with the prior announcement.
  return buildClaudeStatusPayload(state, eventName, '', paneKey, hookPayload, {
    ...resolveClaudePaneStatus(state, paneKey, { ...lead, state: leadState }),
    updateToolSnapshot: false
  })
}
