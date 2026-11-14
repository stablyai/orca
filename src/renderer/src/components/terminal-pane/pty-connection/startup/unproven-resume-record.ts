import { useAppStore } from '@/store/index'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** The record a resume spawn kept, until the resumed agent proves it took the conversation over. */
export type UnprovenResumeRecord = {
  record: SleepingAgentSessionRecord
  ptyId: string | null
  spawnedAt: number
}

// Why: a resume spawn proves a PTY, not an agent; one that dies in startup must not take its record along.
export function markUnprovenResumeRecord(session: ConnectPanePtySession): void {
  const kept = session.getSleepingRecordForPane(useAppStore.getState())
  session.unprovenResumeRecord = kept
    ? { record: kept.record, ptyId: session.transport.getPtyId(), spawnedAt: Date.now() }
    : null
}

/** Whether the shell came back before the resumed agent ever reported in on this pane's PTY. */
export function isUnprovenResumeRecord(
  session: ConnectPanePtySession,
  state: ReturnType<typeof useAppStore.getState>,
  sleepingRecord: { record: SleepingAgentSessionRecord } | null,
  ptyId: string | null
): boolean {
  const pending: UnprovenResumeRecord | null | undefined = session.unprovenResumeRecord
  if (!pending || !sleepingRecord || pending.record !== sleepingRecord.record) {
    return false
  }
  if (ptyId !== null && pending.ptyId !== null && pending.ptyId !== ptyId) {
    return false
  }
  // A live report can leave an equivalent record in place, so its own arrival is the proof.
  const live = state.agentStatusByPaneKey[session.cacheKey]
  return !live || live.updatedAt < pending.spawnedAt
}
