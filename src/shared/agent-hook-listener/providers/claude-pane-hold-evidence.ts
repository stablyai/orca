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

/** The one reading of a pane's hold evidence; the fold, the row's flag and the turn-end
 *  announcement must not each keep their own list. `mainAgent` is its state as of this event,
 *  which the caller may not have recorded yet. */
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

/** Live work a Claude row's child list does not show. Restated beside the row so a restart or a
 *  relayed reader cannot settle a main agent that is about to be woken. */
export function claudeRowHasUnlistedLiveWork(state: HookListenerState, paneKey: string): boolean {
  const held = claudePaneHoldEvidence(state, paneKey)
  return held.runningNonAgent || held.owedAgent || held.owedShell
}

/** Child work that is running right now and may run long, as opposed to a notification the main
 *  agent is about to be woken by. Only this earns a held turn end its completion announcement. */
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
  // Why: a task that stopped running is not over until Claude has told the main agent, which
  // starts another main-agent turn; so an owed notification holds the pane like running work.
  const held = claudePaneHoldEvidence(state, paneKey, lead)
  const own = lead.waitingAgentId !== undefined ? lead.stateBeforeWait : lead
  return {
    ...foldAgentLeadStatus({
      leadState: lead.state,
      childWorkLiveness: agentChildWorkLivenessFromEvidence({
        // A child's permission wait displaces the main agent record itself (`waitingAgentId`,
        // `stateBeforeWait`) instead of living on the roster, so the roster never carries one.
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
