import type { AgentStatusEntry } from './agent-status-types'

type AnchorStatus = Pick<AgentStatusEntry, 'state' | 'agentType' | 'providerSession' | 'worktreeId'>
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from './agent-session-resume'
import { isPiCompatibleAgentType } from './pi-agent-kind'

/** Identify a completed pane’s own live resume anchor written at turn end, not a sleep capture.
 * No vendor/automatic-resume gate: this checks record identity, not hibernation eligibility. */
export function isLiveResumeAnchorForCompletedAgent(
  entry: AnchorStatus | undefined,
  record: SleepingAgentSessionRecord | undefined,
  worktreeId?: string
): record is SleepingAgentSessionRecord {
  if (
    entry?.state !== 'done' ||
    !isResumableTuiAgent(entry.agentType) ||
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

// Manual-sleep/quit retention preserves shipped Pi-only semantics; only automatic hibernation broadened.
export function isCompletedPiCompatibleAgentWithLiveRecoveryRecord(
  entry: AnchorStatus | undefined,
  record: SleepingAgentSessionRecord | undefined,
  worktreeId?: string
): record is SleepingAgentSessionRecord {
  return (
    isPiCompatibleAgentType(entry?.agentType) &&
    isLiveResumeAnchorForCompletedAgent(entry, record, worktreeId)
  )
}
