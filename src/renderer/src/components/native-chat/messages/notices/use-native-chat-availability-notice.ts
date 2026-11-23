import {
  nativeChatSetupAction,
  type NativeChatHostSetup
} from '../../host-access/native-chat-host-setup'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { useMemo, useState } from 'react'
import type { AgentSessionUnavailable } from '../../../../../../shared/agent-session/failures/agent-session-availability'
import { readAgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { inSendOrder } from '../../../../../../shared/native-chat/transcript/pending-sends/native-chat-send-order'
import { agentSessionRefusalReasonWords } from '../../../../../../shared/agent-session/failures/agent-session-refusal-reason-words'
import type { AgentSessionWriteRefusal } from '../../../../../../shared/agent-session/failures/agent-session-write-failure'
import { isStructuredAgentSessionStartFailureRow } from '../../../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import {
  cliMissingSentence,
  notSignedInSentence
} from '../../../../../../shared/agent-session/failures/agent-session-availability-sentences'
import {
  nativeChatNotSignedInSentence,
  nativeChatSignInNoticeView
} from '../../host-access/native-chat-sign-in-notice'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'
import { useTranslate } from '@/i18n/use-translate'

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

/** Return the newest rejection reason only while its loaded message and delivery line are visible. */
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

/** Advisory host verdicts never block Send; dismiss per verdict and omit reasons already explained by a failed start or newest send. */
export function useNativeChatAvailabilityNotice(input: {
  setup?: NativeChatHostSetup | null
  unavailable: AgentSessionUnavailable | null | undefined
  agent: AgentType
  /** The WSL distro the chat's host runs in, to say where the agent is missing. */
  wslDistro?: string | null
  launchFailure: AgentSessionWriteRefusal | null
  journalItems: readonly AgentJournalRenderItem[] | undefined
  submissions?: readonly NoticeSubmission[]
  /** The lines under the chat's messages, by message key: a refused send's says why. */
  deliveryNotices?: ReadonlyMap<string, unknown>
}): NativeChatComposerNotice | null {
  const t = useTranslate()
  const { unavailable } = input
  // Both reasons read status rows and ids only, so a streamed reply's text revision keeps them.
  const journalItems = input.journalItems && rowsBesideStreamedText(input.journalItems)
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
  const agentName = structuredAgentLabel(input.agent)
  const signIn = nativeChatSignInNoticeView(
    {
      kind: unavailable.reason,
      agent: input.agent,
      account: unavailable.reason === 'notSignedIn' ? unavailable.account : undefined,
      setup: input.setup
    },
    t
  )
  // No dismiss: it clears once signed in or once a send says why it wasn't sent.
  if (signIn) {
    return {
      key: 'availability',
      kind: 'error',
      text: nativeChatNotSignedInSentence(agentName, t),
      signIn
    }
  }
  return {
    key: 'availability',
    action: nativeChatSetupAction(unavailable.reason, input.setup, t),
    kind: 'error',
    text:
      unavailable.reason === 'cliMissing'
        ? cliMissingSentence(
            {
              agentName,
              ...(input.wslDistro ? { wslDistro: input.wslDistro } : {})
            },
            sayAgentSessionFailureTranslated
          )
        : notSignedInSentence(
            { agentName },
            { kind: 'notSignedIn', account: unavailable.account },
            sayAgentSessionFailureTranslated
          ),
    onDismiss: () => setDismissal({ key, dismissed: true })
  }
}
