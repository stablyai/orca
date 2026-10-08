import { useMemo, useState } from 'react'
import {
  agentSessionSignInCopyId,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { agentSessionRefusalReasonWords } from '../../../../shared/agent-session-refusal-reason-words'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

/** Why the chat's latest start failed, unless a turn has run since. */
function failedStartReason(items: readonly AgentJournalRenderItem[] | undefined): string | null {
  let reason: string | null = null
  for (const item of items ?? []) {
    if (item.body.kind === 'turn') {
      reason = null
    } else if (
      item.body.kind === 'status' &&
      isStructuredAgentSessionStartFailureRow(item.itemId)
    ) {
      reason = readAgentSessionFailureFact(item.body.failure)?.kind ?? null
    }
  }
  return reason
}

/** The host's verdict on why no chat can start here, as a notice that never holds Send: the
 *  verdict can be wrong while a send would work. Dismissed per verdict, so a changed or returning
 *  one shows again; left out while the chat's failed start already says the same reason. */
export function useNativeChatAvailabilityNotice(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  agent: AgentType
  agentLabel: string
  launchFailure: AgentSessionWriteRefusal | null
  journalItems: readonly AgentJournalRenderItem[] | undefined
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
  if (!unavailable || (dismissal.key === key && dismissal.dismissed)) {
    return null
  }
  const launchWords = input.launchFailure && agentSessionRefusalReasonWords(input.launchFailure)
  const launchReason = launchWords && 'fact' in launchWords ? launchWords.fact : null
  if (launchReason === unavailable.reason || rowReason === unavailable.reason) {
    return null
  }
  return {
    key: 'availability',
    kind: 'error',
    text:
      unavailable.reason === 'cliMissing'
        ? sayAgentSessionFailureTranslated('cliMissing', { agent: input.agentLabel })
        : sayAgentSessionFailureTranslated(
            agentSessionSignInCopyId(
              input.agent === 'codex' ? 'codex' : 'claude',
              unavailable.account
            )
          ),
    onDismiss: () => setDismissal({ key, dismissed: true })
  }
}
