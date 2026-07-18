import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'

export function isCompletedRecoveryRecord(
  record: SleepingAgentSessionRecord | undefined
): record is SleepingAgentSessionRecord {
  return Boolean(
    record &&
    ((record.origin === 'completed' && record.state === 'done') ||
      (record.agent === 'pi' && record.origin === 'live'))
  )
}

export function isCompletedAgentRecoveryIdentity(
  entry: AgentStatusEntry | undefined,
  record: SleepingAgentSessionRecord | undefined
): record is SleepingAgentSessionRecord {
  if (
    entry?.state !== 'done' ||
    entry.interrupted === true ||
    !isResumableTuiAgent(entry.agentType) ||
    !entry.providerSession ||
    record?.agent !== entry.agentType ||
    (entry.worktreeId !== undefined && entry.worktreeId !== record.worktreeId) ||
    !agentProviderSessionsEqual(entry.agentType, entry.providerSession, record.providerSession) ||
    !getAgentResumeArgv(record.agent, record.providerSession)
  ) {
    return false
  }
  // Why: Pi's done event ends a turn without ending its TUI, so its equivalent
  // recovery identity intentionally remains live instead of completed.
  return isCompletedRecoveryRecord(record)
}
