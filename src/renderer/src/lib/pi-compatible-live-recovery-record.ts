import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { isPiCompatibleAgentType } from '../../../shared/pi-agent-kind'

export function isCompletedPiCompatibleAgentWithLiveRecoveryRecord(
  entry: AgentStatusEntry | undefined,
  record: SleepingAgentSessionRecord | undefined,
  worktreeId?: string
): record is SleepingAgentSessionRecord {
  if (
    entry?.state !== 'done' ||
    !isPiCompatibleAgentType(entry.agentType) ||
    !entry.providerSession ||
    record?.agent !== entry.agentType ||
    record.origin !== 'live'
  ) {
    return false
  }
  const agent = entry.agentType
  return Boolean(
    (!entry.worktreeId || entry.worktreeId === record.worktreeId) &&
    (!worktreeId || worktreeId === record.worktreeId) &&
    agentProviderSessionsEqual(agent, entry.providerSession, record.providerSession) &&
    getAgentResumeArgv(agent, record.providerSession)
  )
}
