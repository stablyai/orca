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
  const copyEvidence = <T extends { lastEvidence: AgentTurnRecord['lastEvidence'] }>(
    entry: T
  ): T => ({ ...entry, lastEvidence: { ...entry.lastEvidence } })
  return {
    owner: {
      ...state.owner,
      attachment: { ...state.owner.attachment }
    },
    currentTurnId: state.currentTurnId,
    currentTurn: currentTurn ? copyEvidence(currentTurn) : null,
    turns: state.turns.map(copyEvidence),
    joinedChildren: state.work.filter((item) => item.kind === 'joined-child').map(copyEvidence),
    residentBackground: state.work
      .filter((item) => item.kind === 'resident-background')
      .map(copyEvidence),
    dispatches: state.dispatches.map(copyEvidence),
    recoveries: state.recoveries.map(copyEvidence),
    executionVerdict: state.executionVerdict,
    integrityIssues: state.integrityIssues.map((issue) => ({ ...issue }))
  }
}

export function isAgentTurnDispatchSettled(dispatch: AgentTurnDispatchRecord): boolean {
  return dispatch.outcome !== null
}
