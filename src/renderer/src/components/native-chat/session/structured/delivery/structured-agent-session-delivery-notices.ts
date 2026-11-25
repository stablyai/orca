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
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  structuredAgentSessionRetryLineages,
  structuredAgentSessionRetryRow
} from '../../../../../../../shared/agent-session/view/structured-agent-session-retry-lineage'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()

/** Show sending until host rows arrive and host-worded rejections afterward; settled uncertain input remains ordinary transcript content. */
export function structuredAgentSessionDeliveryNotices(args: {
  pending: readonly StructuredAgentSessionPendingSend[]
  submissions: readonly AgentJournalSubmission[]
  agentName: string
  startFailures: readonly AgentSessionFailureFact[]
  onRetry?: (submission: AgentJournalSubmission, bodyClientMessageId: string) => void
  itemIds?: ReadonlySet<string>
  commandItemIds?: ReadonlySet<string>
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, submissions } = args
  let byId: Map<string, AgentJournalSubmission> | undefined
  let pendingRetries: Set<string> | undefined
  let hasRejected = false
  const lineages = structuredAgentSessionRetryLineages(submissions)
  for (const submission of submissions) {
    hasRejected ||= submission.dispatchState === 'rejected'
  }
  for (const entry of args.pending) {
    if (entry.retryOfClientMessageId) {
      ;(pendingRetries ??= new Set()).add(entry.retryOfClientMessageId)
    }
  }
  const notices = new Map<string, NativeChatDeliveryNotice>()
  // A row under the id is the host's to describe, before the sender settles from it.
  const recorded = args.pending.length
    ? new Set(submissions.map((submission) => submission.clientMessageId))
    : null
  for (const entry of args.pending) {
    if (entry.phase !== 'unconfirmed' && !recorded?.has(entry.clientMessageId)) {
      notices.set(
        agentJournalSubmissionKey(entry.retryOfClientMessageId ?? entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  const shown = hasRejected
    ? structuredAgentSessionRejectedShownInPlace(submissions, args.commandItemIds ?? NO_COMMANDS)
        .shown
    : new Set<string>()
  for (const submission of submissions) {
    if (submission.dispatchState === 'accepted' || submission.dispatchState === 'unknown') {
      continue
    }
    const root = submission.retryOfClientMessageId ?? submission.clientMessageId
    const retry = lineages.get(root)
    if (
      retry?.dispatchState === 'accepted' ||
      retry?.dispatchState === 'unknown' ||
      (retry &&
        submission.clientMessageId !== root &&
        submission.clientMessageId !== retry.clientMessageId)
    ) {
      continue
    }
    const id = retry
      ? structuredAgentSessionRetryRow(root, retry, (itemId) => args.itemIds?.has(itemId) ?? true)
      : agentJournalSubmissionKey(root)
    const original = submission.retryOfClientMessageId
      ? ((byId ??= new Map(submissions.map((entry) => [entry.clientMessageId, entry]))).get(
          submission.retryOfClientMessageId
        ) ?? {
          ...submission,
          clientMessageId: submission.retryOfClientMessageId
        })
      : submission
    if (submission.dispatchState === 'pending' || retry?.dispatchState === 'pending') {
      notices.set(id, STRUCTURED_AGENT_SESSION_DELIVERY_SENDING)
    } else if (
      submission.dispatchState === 'rejected' &&
      (shown.has(id) ||
        submission.keptAsQueuedMessageId ||
        submission.queuedMessageId ||
        (submission.retryOfClientMessageId && original))
    ) {
      // A failed start's words, unless its row carries them; other sentences quote their own.
      const cardId = submission.keptAsQueuedMessageId ?? submission.queuedMessageId
      const fact = readWholeAgentSessionFailureFact(submission.rejection)
      const statedByRow =
        !fact?.instructionRecovery && agentSessionFailureStatedByRow(fact, args.startFailures)
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
        ...(detail ? { detail } : {}),
        ...(fact?.instructionRecovery &&
        original.origin === 'client' &&
        (cardId || (args.onRetry && !pendingRetries?.has(original.clientMessageId)))
          ? {
              ...(cardId
                ? { recoveryCardId: cardId }
                : { onSend: () => args.onRetry?.(original, submission.clientMessageId) }),
              recoveryFocus: fact.instructionRecovery !== 'pending'
            }
          : {})
      })
    }
  }
  return notices
}
