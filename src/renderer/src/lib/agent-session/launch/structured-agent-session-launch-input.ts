import { launchStateLifecycle } from '../../structured-agent-session-launch-lifecycle'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  getPersistedStructuredAgentLaunchRecord,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

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
      !!state.intent.params.firstMessage
    )
  }
  const record = getPersistedStructuredAgentLaunchRecord(sessionId)
  return !!record?.firstMessage && record.lifecycle !== 'failed'
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
  const firstMessage = state?.intent.params.firstMessage ?? record?.firstMessage
  const submission = firstMessage && readRecorded().get(firstMessage.clientMessageId)
  if (!submission) {
    return
  }
  if (state) {
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
  notifyStructuredLaunchListeners()
}

/** The launch adopts an existing conversation, which may keep a model of its own. */
export function getStructuredAgentSessionLaunchResumes(sessionId: string): boolean {
  // A fork opens onto history it adopts, as a resume does.
  const params =
    getStructuredLaunchStateBySessionId(sessionId)?.intent.params ??
    getPersistedStructuredAgentLaunchRecord(sessionId)
  return params?.resumeFrom !== undefined || params?.forkFrom !== undefined
}
