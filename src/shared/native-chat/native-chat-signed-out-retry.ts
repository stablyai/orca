// Retry a start the agent refused for want of a login: which send it re-sends, on every surface.

import { readWholeAgentSessionFailureFact } from '../agent-session/failures/agent-session-failure'
import type { AgentJournalSubmission } from '../agent-session/journal/agent-session-journal-types'

/** The host re-sends such a send on Retry, and on its own once the account can launch again. */
export const AGENT_SESSION_SIGNED_OUT_RETRY_RUNTIME_CAPABILITY =
  'agent-session.signed-out-retry.v1' as const

type SignedOutSend = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'rejection' | 'queuedMessageId' | 'keptAsQueuedMessageId'
>

/** The chat's latest send, when its start was refused only because the agent wasn't signed in. */
export function latestNativeChatSignedOutSend<T extends SignedOutSend>(
  submissions: readonly T[]
): T | null {
  const latest = submissions.at(-1)
  return latest?.dispatchState === 'rejected' &&
    readWholeAgentSessionFailureFact(latest.rejection)?.kind === 'notSignedIn'
    ? latest
    : null
}

/** The queued card holding that send's text, whose own Send is its Retry; null for a plain send. */
export function nativeChatSignedOutSendCard(send: SignedOutSend): string | null {
  return send.queuedMessageId ?? send.keptAsQueuedMessageId ?? null
}
