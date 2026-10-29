import { foldAgentLeadStatus, type AgentLeadStatusResolution } from '../../agent-lead-status-fold'
import { agentChildWorkLivenessFromEvidence } from '../../agent-status-child-work-liveness'
import { claudeLiveOwedTaskNotificationKinds } from '../../claude-owed-task-notifications'
import { claudeRosterHasWorkingSubagent } from '../../claude-subagent-roster'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import { mainAgentIdleSince } from '../main-agent-turn-state'

/** Everything that can hold a pane whose main agent's own turn is over. */
type ClaudePaneHoldEvidence = {
  /** A sub-agent the roster tracks as working. */
  runningAgent: boolean
  /** A running shell or a scheduled session cron. */
  runningNonAgent: boolean
  /** An ended sub-agent / shell whose notification Claude has not delivered yet. */
  owedAgent: boolean
  owedShell: boolean
}

/** Share hold evidence across fold/row flags/announcements; mainAgent may not yet be recorded for this event. */
export function claudePaneHoldEvidence(
  state: HookListenerState,
  paneKey: string,
  mainAgent: Pick<ClaudeLeadTurnState, 'state'> | undefined = state.claudeLeadStateByPaneKey.get(
    paneKey
  )
): ClaudePaneHoldEvidence {
  const owed = claudeLiveOwedTaskNotificationKinds(
    state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
    mainAgent?.state === 'done',
    mainAgentIdleSince(state.claudeLeadStateByPaneKey.get(paneKey))
  )
  return {
    runningAgent: claudeRosterHasWorkingSubagent(state.claudeSubagentRosterByPaneKey.get(paneKey)),
    runningNonAgent:
      state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
      state.claudeActiveSessionCronPaneKeys.has(paneKey),
    owedAgent: owed.agent,
    owedShell: owed.shell
  }
}

/** Restate unlisted live work so restarts/relays cannot settle a main agent still awaiting wakeup. */
export function claudeRowHasUnlistedLiveWork(state: HookListenerState, paneKey: string): boolean {
  const held = claudePaneHoldEvidence(state, paneKey)
  return held.runningNonAgent || held.owedAgent || held.owedShell
}

/** Only running work earns a held-turn completion announcement; owed notifications will wake the lead shortly. */
export function claudePaneHasRunningChildWork(state: HookListenerState, paneKey: string): boolean {
  const held = claudePaneHoldEvidence(state, paneKey)
  return held.runningAgent || held.runningNonAgent
}

export type ClaudePaneStatusResolution = AgentLeadStatusResolution & {
  claudeTaskWakeupPending?: 'notification' | 'finishing-turn'
}

export function resolveClaudePaneStatus(
  state: HookListenerState,
  paneKey: string,
  lead: Pick<ClaudeLeadTurnState, 'state' | 'taskWakeupTurn' | 'waitingAgentId' | 'stateBeforeWait'>
): ClaudePaneStatusResolution {
  // Tasks still owe main-agent notifications after ending; those wakeup turns keep the pane live.
  const held = claudePaneHoldEvidence(state, paneKey, lead)
  const own = lead.waitingAgentId !== undefined ? lead.stateBeforeWait : lead
  return {
    ...foldAgentLeadStatus({
      leadState: lead.state,
      childWorkLiveness: agentChildWorkLivenessFromEvidence({
        // Child waits displace the lead record; the roster carries none.
        hasWaitingChildWork: false,
        hasLiveAgentWork: held.runningAgent || held.owedAgent,
        hasLiveNonAgentWork: held.runningNonAgent || held.owedShell
      })
    }),
    ...(held.owedAgent || held.owedShell
      ? { claudeTaskWakeupPending: 'notification' as const }
      : own?.state !== 'done' && own?.taskWakeupTurn
        ? { claudeTaskWakeupPending: 'finishing-turn' as const }
        : {})
  }
}
