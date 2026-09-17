import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { isPiCompatibleAgentType } from '../../../shared/pi-agent-kind'
import { isAgentStatusTurnComplete } from '../../../shared/agent-completion-time'

/**
 * True when `record` is nothing more than this completed pane's own live resume
 * anchor — the checkpoint `setAgentStatus` writes for every resumable agent the
 * moment its turn ends — rather than a real sleep capture.
 *
 * Deliberately carries no vendor gate and no automatic-resume check: it answers
 * "does this record match the pane?", not "may this pane be hibernated?".
 */
export function isLiveResumeAnchorForCompletedAgent(
  entry: AgentStatusEntry | undefined,
  record: SleepingAgentSessionRecord | undefined,
  worktreeId?: string
): record is SleepingAgentSessionRecord {
  if (
    !entry ||
    !isAgentStatusTurnComplete(entry) ||
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

// Why: retention call sites (manual-sleep promotion, quit capture) keep the
// Pi-only meaning they shipped with; only automatic hibernation broadened.
export function isCompletedPiCompatibleAgentWithLiveRecoveryRecord(
  entry: AgentStatusEntry | undefined,
  record: SleepingAgentSessionRecord | undefined,
  worktreeId?: string
): record is SleepingAgentSessionRecord {
  return (
    isPiCompatibleAgentType(entry?.agentType) &&
    isLiveResumeAnchorForCompletedAgent(entry, record, worktreeId)
  )
}
