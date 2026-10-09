// The words for a message the host rejected, shared by the desktop, the phone and the queue's
// returned cards.

import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNotDoneParts
} from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionFailureStatedByStartRow } from './structured-agent-session-start-failure-facts'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import { isProviderDiagnosticPersonText } from './provider-diagnostic-person-text'

/**
 * What to put on screen for a rejection.
 *
 * A content rejection's reason is the provider explaining itself, so it is shown
 * verbatim — "Claude does not support the image type .bmp" is the whole answer and
 * a generic string would throw it away. A transport rejection's reason is an
 * internal marker; printing it put `provider_write_failed: broken pipe` in front of
 * users, which names nothing they can act on. That case gets copy that says what
 * happened, and on the phone that the message can be sent again — which it can,
 * because the frame provably never left, so a resend cannot duplicate.
 *
 * The null default claims no cause and no next step, because at that point we know
 * neither: all it asserts is the one thing every rejection shares.
 *
 * Exported because the phone needs the same copy: the rule about
 * which reasons a person may read is a property of the reason, not of the queue.
 */
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
    return rejectionFactParts(write, { kind: 'writeFailed' }, context)
  }
  if (rejection.kind) {
    return agentSessionWriteNotDoneParts(write)
  }
  // A reason-only row cannot identify its author or recover its cause; use a named neutral lead.
  const parts = rejectionFactParts(write, { kind: 'providerRejected' }, context)
  if (!isProviderDiagnosticPersonText(reason)) {
    return parts
  }
  const alreadyNamed =
    !context.agentName || reason.toLowerCase().includes(context.agentName.toLowerCase())
  return alreadyNamed ? [{ text: reason }] : [...parts, { text: reason }]
}

function rejectionFactParts(
  write: 'send' | 'composer-send',
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] {
  const { kind } = classifyDispatchRejection({ reason: null, rejection: fact })
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

/** The line under a message the host recorded and then rejected, in the host's terms. A failed
 *  start's loaded row already says why, so then it says only that the message was not sent. */
export function structuredAgentSessionRecordedRejectionParts(
  submission: AgentJournalSubmission,
  context: AgentSessionFailureWordsContext,
  startFailures: readonly AgentSessionFailureFact[]
): AgentSessionWriteNoticePart[] {
  if (agentSessionFailureStatedByStartRow(submission.rejection, startFailures)) {
    return agentSessionWriteNotDoneParts('send')
  }
  return structuredAgentSessionRejectionParts(
    submission.reason,
    'send',
    readWholeAgentSessionFailureFact(submission.rejection),
    context
  )
}
