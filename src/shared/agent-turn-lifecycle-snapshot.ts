import type {
  AgentTurnDispatchRecord,
  AgentTurnLifecycleState,
  AgentTurnRecord,
  AgentTurnWorkRecord
} from './agent-turn-lifecycle-contract'

export type AgentTurnLifecycleSnapshot = Readonly<{
  owner: AgentTurnLifecycleState['owner']
  currentTurnId: AgentTurnLifecycleState['currentTurnId']
  currentTurn: AgentTurnRecord | null
  turns: readonly AgentTurnRecord[]
  joinedChildren: readonly AgentTurnWorkRecord[]
  residentBackground: readonly AgentTurnWorkRecord[]
  dispatches: readonly AgentTurnDispatchRecord[]
  recoveries: AgentTurnLifecycleState['recoveries']
  executionVerdict: AgentTurnLifecycleState['executionVerdict']
  integrityIssues: AgentTurnLifecycleState['integrityIssues']
}>

export function readAgentTurnLifecycleSnapshot(
  state: AgentTurnLifecycleState
): AgentTurnLifecycleSnapshot {
  const currentTurn = state.currentTurnId
    ? (state.turns.find((turn) => turn.turnId === state.currentTurnId) ?? null)
    : null
  return {
    owner: state.owner,
    currentTurnId: state.currentTurnId,
    currentTurn,
    turns: state.turns,
    joinedChildren: state.work.filter((item) => item.kind === 'joined-child'),
    residentBackground: state.work.filter((item) => item.kind === 'resident-background'),
    dispatches: state.dispatches,
    recoveries: state.recoveries,
    executionVerdict: state.executionVerdict,
    integrityIssues: state.integrityIssues
  }
}

export function isAgentTurnDispatchSettled(dispatch: AgentTurnDispatchRecord): boolean {
  return dispatch.outcome !== null
}
