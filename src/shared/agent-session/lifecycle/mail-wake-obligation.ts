import { agentProviderSessionsEqual, type SleepingAgentSessionRecord } from './agent-session-resume'
import type { AgentStatusIpcPayload } from '../../agent-status/contracts/agent-status-ipc-payload'
import { isWorkspaceSleepRecord } from '../../workspace-sleep'

/** Custody is independent of whether its pane currently owns a shell. */
export function mailWakeObligation(record: SleepingAgentSessionRecord | null | undefined) {
  if (!record) {
    return null
  }
  if (record.origin === 'worktree-sleep' && isWorkspaceSleepRecord(record)) {
    return 'manual' as const
  }
  if (record.mailWake) {
    return 'retained' as const
  }
  return record.origin === 'worktree-sleep' ? ('automatic' as const) : null
}

export function confirmsMailWake(
  record: SleepingAgentSessionRecord,
  row: AgentStatusIpcPayload,
  currentPtyId: string | null | undefined
): boolean {
  const attempt = record.mailWake?.attempt
  return (
    mailWakeObligation(record) === 'retained' &&
    !!attempt &&
    currentPtyId === attempt.ptyId &&
    row.launchToken === attempt.launchToken &&
    row.connectionId === (record.connectionId ?? null) &&
    row.paneKey === record.paneKey &&
    !row.isReplay &&
    !row.restoredUnconfirmed &&
    !row.providerSessionOnly &&
    !row.programStatusOnly &&
    (row.observation?.origin === 'hook' || row.observation?.origin === 'osc') &&
    row.observation.kind !== 'snapshot' &&
    row.agentType === record.agent &&
    agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
  )
}

export function withoutMailWake(record: SleepingAgentSessionRecord): SleepingAgentSessionRecord {
  const { mailWake: _settled, ...rest } = record
  return rest
}

export function mailWakeEligibility(records: readonly SleepingAgentSessionRecord[]): string {
  return JSON.stringify(
    records
      .filter((record) => mailWakeObligation(record))
      .map((record) => [
        record.paneKey,
        record.mailWake?.capturedAt ?? record.capturedAt,
        mailWakeObligation(record) === 'manual'
      ])
      .sort()
  )
}
