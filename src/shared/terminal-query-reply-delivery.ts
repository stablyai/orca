import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  extractOnlyTerminalQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

export type TerminalQueryReplyPayloadDelivery = 'unrecognized' | 'wrote' | 'write-failed'

/**
 * Recognizes a whole reply payload and reports whether any write landed.
 *
 * Only a payload made entirely of cooked-echo-risk replies is taken. Those need their
 * echo shapes armed around the write, and they are what a program sits blocked on, so
 * they bypass the host's startup input gate. Everything else — CPR, DA, and any mixed
 * payload — stays on the host's own path and is written there in call order, which is
 * what keeps a CPR from passing the daemon's post-ready flush gate and splicing into the
 * buffered startup command.
 *
 * Ordering needs no machinery here: every reply is written the moment it is accepted, so
 * the pty sees them in the order the caller produced them.
 */
export function deliverTerminalQueryReplyPayload(
  data: string,
  delivery: Pick<PtyStartupReplyDelivery, 'answer'>
): TerminalQueryReplyPayloadDelivery {
  const replies = extractOnlyTerminalQueryReplies(data)
  if (!replies || !replies.every(needsCookedEchoSafeQueryReply)) {
    return 'unrecognized'
  }
  let wroteAny = false
  for (const reply of replies) {
    wroteAny = delivery.answer(reply) || wroteAny
  }
  return wroteAny ? 'wrote' : 'write-failed'
}
