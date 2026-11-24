import { agentSessionFailureDetailText } from '../../../../../../../shared/agent-session/failures/agent-session-failure-quoted-detail'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureStatedByRow } from '../../../../../../../shared/agent-session/failures/agent-session-visible-failures'
import { classifyDispatchRejection } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionRejectionParts } from '../../../../../../../shared/agent-session/failures/structured-agent-session-rejection-words'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { agentSessionWriteNotDoneParts } from '../../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from '../../../messages/notices/agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'

const NO_COMMANDS: ReadonlySet<string> = new Set()

/** Host-worded rejections that draw on their own message row. */
export function structuredAgentSessionDeliveryNotices(args: {
  submissions: readonly AgentJournalSubmission[]
  agentName: string
  startFailures: readonly AgentSessionFailureFact[]
  commandItemIds?: ReadonlySet<string>
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, submissions } = args
  const notices = new Map<string, NativeChatDeliveryNotice>()
  const shown = submissions.some((submission) => submission.dispatchState === 'rejected')
    ? structuredAgentSessionRejectedShownInPlace(submissions, args.commandItemIds ?? NO_COMMANDS)
        .shown
    : new Set<string>()
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (submission.dispatchState === 'rejected' && shown.has(id)) {
      // A failed start's words, unless its row carries them; other sentences quote their own.
      const fact = readWholeAgentSessionFailureFact(submission.rejection)
      const statedByRow = agentSessionFailureStatedByRow(fact, args.startFailures)
      const detail =
        fact &&
        classifyDispatchRejection({ reason: null, rejection: fact }).category === 'startFailed' &&
        !statedByRow
          ? agentSessionFailureDetailText(fact)
          : undefined
      notices.set(id, {
        failureKind: statedByRow ? undefined : fact?.kind,
        ...(fact?.kind === 'notSignedIn' && !statedByRow
          ? { signIn: { agentName, ...(fact.account ? { account: fact.account } : {}) } }
          : {}),
        text: agentSessionWriteNoticeText(
          statedByRow
            ? agentSessionWriteNotDoneParts('send')
            : structuredAgentSessionRejectionParts(submission.reason, 'send', fact, { agentName })
        ),
        ...(detail ? { detail } : {})
      })
    }
  }
  return notices
}
