import type { AgentMainAgentStatus } from '../../agent-status/lifecycle/main-agent-status'
import type { CodexLeadTurnState } from '../main-agent-turn-state'

/** The `mainAgent` fact a Codex row publishes, straight from the root record. */
export function codexMainAgentStatusForPayload(
  record: CodexLeadTurnState | undefined
): AgentMainAgentStatus | undefined {
  return record
    ? {
        state: record.state,
        ...(record.state === 'done' && record.outcome ? { outcome: record.outcome } : {}),
        ...(record.state === 'done' && record.outcome === 'failure' && record.usageLimit
          ? { usageLimit: record.usageLimit }
          : {}),
        stateStartedAt: record.stateStartedAt
      }
    : undefined
}

/** Interrupt records cancellation; late Stops restate the ended turn's verdict until a new turn clears it. */
export function codexLeadOutcomeForEvent(
  eventName: unknown,
  previous: CodexLeadTurnState | undefined,
  nextState: CodexLeadTurnState['state']
): Pick<CodexLeadTurnState, 'outcome'> {
  if (eventName === 'Interrupt') {
    return { outcome: 'cancellation' }
  }
  return nextState === 'done' && previous?.state === 'done' && previous.outcome
    ? { outcome: previous.outcome }
    : {}
}
