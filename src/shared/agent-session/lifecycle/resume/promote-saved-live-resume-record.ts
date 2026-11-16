import { getAgentResumeArgv } from '../../../agent-launch/startup/agent-resume-argv'
import {
  isPaneSleepRecord,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../agent-session-resume'

/** Promote the pane's live checkpoint when its volatile status is missing. */
export function promoteSavedLiveResumeRecord(args: {
  record: SleepingAgentSessionRecord | undefined
  worktreeId: string
  capturedAt: number
  includeSleepRecord?: boolean
}): SleepingAgentSessionRecord | null {
  const { record, worktreeId, capturedAt } = args
  if (
    !record ||
    record.worktreeId !== worktreeId ||
    (record.origin !== 'live' && !(args.includeSleepRecord && isPaneSleepRecord(record))) ||
    !isResumableTuiAgent(record.agent) ||
    !getAgentResumeArgv(record.agent, record.providerSession)
  ) {
    return null
  }
  if (record.origin !== 'live') {
    return record
  }
  return {
    ...record,
    state: 'working',
    capturedAt,
    updatedAt: capturedAt,
    origin: 'worktree-sleep'
  }
}
