// How the structured session reducer folds a frame's per-frame side fields (host clock,
// queue publication, async questions) into its state.

import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from './agent-session-queued-message-wire'
import {
  readNativeChatAsyncQuestionsField,
  type NativeChatAsyncQuestionsField
} from './native-chat-async-questions'
import type { StructuredAgentHostClock } from './structured-agent-session-reducer'

/** A frame without `hostNow` (older host) leaves the previous sample in place. */
export function hostClockField(
  hostNow: number | undefined,
  receivedAt: number,
  previous: StructuredAgentHostClock | undefined
): { hostClock?: StructuredAgentHostClock } {
  const hostClock = hostNow !== undefined ? { hostNow, receivedAt } : previous
  return hostClock ? { hostClock } : {}
}

type QueuePublication = {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  queuePause?: AgentSessionQueuePause | null
}

/** First claim with a list wins, and its pause rides with it; no claim at all leaves both absent
 *  (older host). */
export function queuePublicationField(...claims: QueuePublication[]): QueuePublication {
  for (const claim of claims) {
    if (claim.queuedMessages !== undefined) {
      return { queuedMessages: claim.queuedMessages, queuePause: claim.queuePause ?? null }
    }
  }
  return {}
}

/** A batch omits the set when unchanged, so absence there keeps the previous one. */
export function asyncQuestionsField(value: unknown): {
  asyncQuestions?: NativeChatAsyncQuestionsField
} {
  const asyncQuestions = readNativeChatAsyncQuestionsField(value)
  return asyncQuestions ? { asyncQuestions } : {}
}
