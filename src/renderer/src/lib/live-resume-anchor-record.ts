import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { isPiCompatibleAgentType } from '../../../shared/pi-agent-kind'

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

/**
 * A durable orchestration fence against automatic provider relaunch. Hibernating
 * a fenced pane would strand it or — since `sleepingRecordFromEntry` does not copy
 * the flag — erase the fence and later auto-resume prohibited work.
 */
export function isAutomaticHibernationAllowed(
  record: SleepingAgentSessionRecord | undefined
): boolean {
  return !record?.automaticResumeBlockedBy
}
