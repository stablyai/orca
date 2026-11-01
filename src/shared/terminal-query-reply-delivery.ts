import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  extractOnlyTerminalQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

/** Return true only after writing the whole payload. Cooked-echo-risk-only replies arm echo protection and bypass startup gating.
 * Keep CPR/DA/mixed payloads on the host’s ordered path so replies cannot splice into buffered startup commands; accepted writes retain caller order. */
export function deliverTerminalQueryReplyPayload(
  data: string,
  delivery: Pick<PtyStartupReplyDelivery, 'answer'>
): boolean {
  const replies = extractOnlyTerminalQueryReplies(data)
  if (!replies || !replies.every(needsCookedEchoSafeQueryReply)) {
    return false
  }
  let accepted = false
  for (const reply of replies) {
    accepted = delivery.answer(reply) || accepted
  }
  return accepted
}
