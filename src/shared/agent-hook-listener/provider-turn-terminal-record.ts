import { normalizeProviderTurnIdentity } from './provider-turn-identity'
import { providerTurnEventId } from './provider-turn-event-id'
import type {
  ProviderTerminalTurnRecordInput,
  ProviderTurnEvidenceRead
} from './provider-turn-evidence-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Terminal records recover a missed start only when run and attachment keys match. */
export function readProviderTerminalTurnRecord(
  input: ProviderTerminalTurnRecordInput
): ProviderTurnEvidenceRead {
  if (!isRecord(input.record)) {
    return { evidence: [], ignored: 'unsupported' }
  }
  const record = input.record
  const turnId = normalizeProviderTurnIdentity(record.turnId ?? record.turn_id ?? record.id)
  const recordRunId = normalizeProviderTurnIdentity(record.runId ?? record.run_id)
  const recordExecutionId = normalizeProviderTurnIdentity(record.executionId ?? record.execution_id)
  if (!turnId || !recordRunId || !recordExecutionId) {
    return { evidence: [], ignored: 'anonymous-outcome' }
  }
  if (
    recordRunId !== normalizeProviderTurnIdentity(input.runId) ||
    recordExecutionId !== normalizeProviderTurnIdentity(input.executionId)
  ) {
    return { evidence: [], ignored: 'anonymous-outcome' }
  }
  const outcome =
    record.outcome === 'interrupted' || record.state === 'interrupted'
      ? 'interrupted'
      : record.outcome === 'failed' || record.state === 'failed'
        ? 'failed'
        : record.outcome === 'completed' || record.state === 'completed'
          ? 'completed'
          : null
  if (!outcome) {
    return { evidence: [], ignored: 'unsupported' }
  }
  const observedAt = input.observedAt ?? Date.now()
  return {
    evidence: [
      {
        source: input.source,
        producerId: `provider:${input.source}`,
        eventId: providerTurnEventId(
          input.source,
          input.paneKey,
          'terminal_record',
          turnId,
          outcome,
          'terminal-record'
        ),
        observedAt,
        kind: outcome === 'interrupted' ? 'turn-interrupt-acknowledged' : 'turn-outcome-observed',
        turnId,
        outcome,
        recordKind: 'terminal-record'
      }
    ]
  }
}
