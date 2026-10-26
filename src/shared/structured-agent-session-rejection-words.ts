import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNotDoneParts
} from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionFailureStatedByRow } from './agent-session-visible-failures'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'

/** Show provider content refusals verbatim, but replace internal transport markers with actionable copy across desktop/mobile.
 * Proven non-delivery permits resend without duplication; a null reason claims no unknown cause or next step. */
export function structuredAgentSessionRejectionNotice(
  reason: string | null,
  write: 'send' | 'composer-send'
): string {
  return agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, write))
}

export function structuredAgentSessionRejectionParts(
  reason: string | null,
  write: 'send' | 'composer-send',
  /** The host's typed fact, which decides when the row carried one. */
  fact?: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext = {}
): AgentSessionWriteNoticePart[] {
  if (fact) {
    return rejectionFactParts(write, fact, context)
  }
  if (reason === null) {
    return ['notDoneSend']
  }
  const rejection = classifyDispatchRejection({ reason })
  if (rejection.kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // Legacy markers need user-facing copy; other reasons are sentences intended for display.
  return rejection.kind ? agentSessionWriteNotDoneParts(write) : [{ text: reason }]
}

/** Deduplicate against visible start-failure facts so one recorded rejection says its reason once. */
export function structuredAgentSessionRecordedRejectionParts(
  submission: AgentJournalSubmission,
  context: AgentSessionFailureWordsContext,
  startFailures: readonly AgentSessionFailureFact[]
): AgentSessionWriteNoticePart[] {
  if (agentSessionFailureStatedByRow(submission.rejection, startFailures)) {
    return agentSessionWriteNotDoneParts('send')
  }
  return structuredAgentSessionRejectionParts(
    submission.reason,
    'send',
    readWholeAgentSessionFailureFact(submission.rejection),
    context
  )
}

function rejectionFactParts(
  write: 'send' | 'composer-send',
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] {
  const { kind } = classifyDispatchRejection({ reason: null, rejection: fact })
  if (kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // A fact this build cannot place proves only that the message did not happen.
  return kind
    ? [{ failure: { ...fact, kind }, surface: 'rejection', context }]
    : agentSessionWriteNotDoneParts(write)
}

/** What a returned queue card says about why the host rejected its message. */
export function structuredAgentSessionAttemptFailureParts(
  failure: { kind: 'rejected'; reason: string | null },
  context: AgentSessionFailureWordsContext = {},
  /** The journal's whole fact for the rejection, when the host sent one this build can read. */
  recorded?: AgentSessionFailureFact
): AgentSessionWriteNoticePart[] {
  return structuredAgentSessionRejectionParts(failure.reason, 'send', recorded, context)
}
