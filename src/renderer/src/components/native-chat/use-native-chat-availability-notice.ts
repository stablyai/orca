import { useMemo, useState } from 'react'
import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { inSendOrder } from '../../../../shared/native-chat-send-order'
import { agentSessionRefusalReasonWords } from '../../../../shared/agent-session-refusal-reason-words'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { notSignedInSentence } from '../../../../shared/agent-session-availability-sentences'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

/** Why the chat's latest start failed, unless a turn has run since. */
function failedStartReason(items: readonly AgentJournalRenderItem[] | undefined): string | null {
  let reason: string | null = null
  for (const item of items ?? []) {
    if (item.body.kind === 'turn') {
      reason = null
    } else if (item.body.kind === 'status') {
      const failure = readAgentSessionFailureFact(item.body.failure)
      if (isStructuredAgentSessionStartFailureRow(item.itemId) || failure?.kind === 'notSignedIn') {
        reason = failure?.kind ?? null
      }
    }
  }
  return reason
}

type NoticeSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'rejection' | 'submittedAt' | 'submittedSequence'
>

/** Why the newest send was turned away, while that send's own line on screen says so: its row is
 *  loaded and carries the line. */
function shownRejectionReason(
  submissions: readonly NoticeSubmission[],
  shownLines: ReadonlyMap<string, unknown>,
  items: readonly AgentJournalRenderItem[]
): string | null {
  const newest = inSendOrder(submissions, (submission) => submission).at(-1)
  const key = newest && agentJournalSubmissionKey(newest.clientMessageId)
  return newest?.dispatchState === 'rejected' &&
    key !== undefined &&
    shownLines.has(key) &&
    items.some((item) => item.itemId === key)
    ? (readAgentSessionFailureFact(newest.rejection)?.kind ?? null)
    : null
}

/** The host's verdict on why no chat can start here, as a notice that never holds Send: the
 *  verdict can be wrong while a send would work. Dismissed per verdict, so a changed or returning
 *  one shows again; left out while the chat's failed start or newest send already says it. */
export function useNativeChatAvailabilityNotice(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  agent: AgentType
  agentLabel: string
  launchFailure: AgentSessionWriteRefusal | null
  journalItems: readonly AgentJournalRenderItem[] | undefined
  submissions?: readonly NoticeSubmission[]
  /** The lines under the chat's messages, by message key: a refused send's says why. */
  deliveryNotices?: ReadonlyMap<string, unknown>
}): NativeChatComposerNotice | null {
  const { unavailable, journalItems } = input
  const key = !unavailable
    ? null
    : unavailable.reason === 'notSignedIn'
      ? `notSignedIn:${unavailable.account ?? ''}`
      : unavailable.reason
  const [dismissal, setDismissal] = useState({ key, dismissed: false })
  if (dismissal.key !== key) {
    setDismissal({ key, dismissed: false })
  }
  const rowReason = useMemo(() => failedStartReason(journalItems), [journalItems])
  const sendReason = useMemo(
    () =>
      shownRejectionReason(
        input.submissions ?? [],
        input.deliveryNotices ?? new Map(),
        journalItems ?? []
      ),
    [input.submissions, input.deliveryNotices, journalItems]
  )
  if (!unavailable || (dismissal.key === key && dismissal.dismissed)) {
    return null
  }
  const launchWords = input.launchFailure && agentSessionRefusalReasonWords(input.launchFailure)
  const launchReason = launchWords && 'fact' in launchWords ? launchWords.fact : null
  if (
    launchReason === unavailable.reason ||
    rowReason === unavailable.reason ||
    sendReason === unavailable.reason
  ) {
    return null
  }
  return {
    key: 'availability',
    kind: 'error',
    text:
      unavailable.reason === 'cliMissing'
        ? sayAgentSessionFailureTranslated('cliMissing', { agent: input.agentLabel })
        : notSignedInSentence(
            { agentName: input.agentLabel },
            { kind: 'notSignedIn', account: unavailable.account },
            sayAgentSessionFailureTranslated
          ),
    onDismiss: () => setDismissal({ key, dismissed: true })
  }
}
