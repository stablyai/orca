import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'

export function answerStartupColorQuery(
  intent: PtyStartupIngressIntent | undefined,
  slots: readonly TerminalOscColorQuerySlot[],
  answeredSlots: Set<TerminalOscColorQuerySlot>,
  delivery: PtyStartupReplyDelivery
): boolean {
  if (slots.some((slot) => answeredSlots.has(slot)) || !intent) {
    return false
  }
  const replies = terminalOscColorQueryReplies(intent.colors, slots)
  if (!replies) {
    return false
  }

  let wroteAny = false
  for (const [index, reply] of replies.entries()) {
    const slot = slots[index]
    if (slot === undefined) {
      return wroteAny
    }
    answeredSlots.add(slot)
    // Why per slot: the replies to one query are written independently, so a
    // deferred write that fails after reporting success invalidates only its own
    // claim. Dropping every claim would let a slot that did land be answered a
    // second time, and a duplicate reply corrupts a parser already mid-read.
    if (!delivery.answer(reply)) {
      answeredSlots.delete(slot)
      return wroteAny
    }
    wroteAny = true
  }

  return wroteAny
}
