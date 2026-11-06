import { launchStateLifecycle } from '../../structured-agent-session-launch-lifecycle'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  getPersistedStructuredAgentLaunchRecord,
  notifyStructuredLaunchStateChanged,
  publishStructuredLaunchStatus
} from './structured-agent-session-launch-registry'
import { ordinaryLaunchOpening } from './structured-agent-session-launch-opening'

/** Existing opening content is correlation after uncertainty, not an active create. */
export function structuredAgentSessionLaunchHasRetainedInput(
  worktreeId: string,
  sessionId: string
): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state) {
    return (
      state.intent.worktreeId === worktreeId &&
      launchStateLifecycle(state) === 'visibility-unknown' &&
      !!ordinaryLaunchOpening(state.intent)
    )
  }
  const record = getPersistedStructuredAgentLaunchRecord(sessionId)
  // A host launch's saved opening is its host's to found the chat with, never the chat's to send.
  return (
    !!record?.firstMessage &&
    record.hostLaunchOperationId === undefined &&
    record.lifecycle !== 'failed'
  )
}

/** Exact host recording retires saved opening ownership without restarting a completed caller. */
export function settleStructuredLaunchFirstMessageFromJournal(
  sessionId: string,
  readRecorded: () => ReadonlyMap<string, AgentJournalSubmission>,
  cursor?: AgentJournalCursor | null
): void {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (
    state &&
    (state.cancelled ||
      (state.callers.outcome === 'failed' && !state.visibilityUnknown) ||
      state.callers.outcome === 'published')
  ) {
    return
  }
  const record = getPersistedStructuredAgentLaunchRecord(sessionId)
  if (!state && record?.lifecycle === 'failed') {
    return
  }
  const firstMessage = state ? state.intent.opening : record?.firstMessage
  const submission = firstMessage && readRecorded().get(firstMessage.clientMessageId)
  if (!submission) {
    return
  }
  if (state) {
    // The chat's journal has the host launch's opening: the window owes it no longer.
    if (state.intent.hostLaunch) {
      delete state.intent.opening
    }
    state.visibilityUnknown = false
    delete state.failure
    state.callers.outcome = 'published'
    state.promise = import('./structured-agent-session-launch-create-message').then(
      ({ publishStructuredLaunchCreateOptions }) =>
        publishStructuredLaunchCreateOptions(state, {
          sessionId,
          fence: submission.fence,
          firstMessage: submission,
          ...(cursor ? { cursor } : {})
        })
    )
  }
  deleteStructuredAgentLaunchRecord(sessionId)
  // Only this launch changed: nothing else is prepared for saving.
  if (state) {
    notifyStructuredLaunchStateChanged(state)
  } else {
    publishStructuredLaunchStatus()
  }
}

/** The launch adopts an existing conversation, which may keep a model of its own. */
export function getStructuredAgentSessionLaunchResumes(sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const resumeFrom = state
    ? state.intent.params.resumeFrom
    : getPersistedStructuredAgentLaunchRecord(sessionId)?.resumeFrom
  return resumeFrom !== undefined
}
