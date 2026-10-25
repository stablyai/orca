import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isWorkspaceSleepRecord } from '../../../shared/workspace-sleep'
import { activationTreatsNoteAsFinished } from './sleeping-agent-pane-ownership'

// A stranded workspace sleep record is the only handle to an unfinished session, never passive history.
export function sweepTreatsAsFinished(record: SleepingAgentSessionRecord): boolean {
  return activationTreatsNoteAsFinished(record) && !isWorkspaceSleepRecord(record)
}

// Main keeps workspace sleep records, so one this sweep settles must leave main's session too.
export function settleSweptRecord(record: SleepingAgentSessionRecord): void {
  useAppStore.getState().clearSleepingAgentSession(record.paneKey)
  if (!isWorkspaceSleepRecord(record)) {
    return
  }
  const { worktreeId, paneKey } = record
  void Promise.resolve()
    .then(() => window.api.worktrees.retireStrandedSleepRecord({ worktreeId, paneKey }))
    .catch((error: unknown) =>
      console.warn('[sleep-resume] could not retire a stranded sleep record', error)
    )
}
