import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

// Why not isFinishedTurnOwingNoResume: a live+done note is a finished turn's idle anchor for a running pane, not sleep.
export function isHibernationDoneRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    (record.origin === undefined || record.origin === 'worktree-sleep') && record.state === 'done'
  )
}

// Why: never remote, where disconnect() only closes this viewer's stream, so the retry re-lands on the same live PTY and loops.
export function hasEmptyReattachRetireEvidence(
  ptyId: string,
  coldRestoreStartup: ColdRestoreAgentResumeStartup | null | undefined
): boolean {
  const record =
    coldRestoreStartup && !coldRestoreStartup.useLiveEntry
      ? coldRestoreStartup.sleepingRecordEntry?.record
      : undefined
  return !isRemoteRuntimePtyId(ptyId) && record !== undefined && isHibernationDoneRecord(record)
}
