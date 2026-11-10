import {
  isPaneSleepRecord,
  isDisplayOnlyPaneSleep,
  type OwnedPaneAgentRecord
} from './agent-session/lifecycle/agent-session-resume'

// Why not activationTreatsNoteAsFinished: a live+done note is a finished turn's idle anchor for a running pane, not sleep.
export function isHibernationDoneRecord(record: OwnedPaneAgentRecord): boolean {
  return isPaneSleepRecord(record) && (isDisplayOnlyPaneSleep(record) || record.state === 'done')
}
