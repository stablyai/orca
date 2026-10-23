import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { isHibernationDoneRecord } from '../../../../../shared/hibernation-done-record'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

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
