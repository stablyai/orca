import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'

type ColorReplyDelivery = {
  answer: (reply: string, onFailed?: () => void) => boolean
  answerImmediately: (reply: string, onFailed?: () => void) => boolean
}

export function answerLiveOscColorQuery(args: {
  slots: readonly TerminalOscColorQuerySlot[]
  colors: TerminalOscColorQueryReplyColors | undefined
  ownerBackend: PtyOwnerBackend
  delivery: ColorReplyDelivery
}): boolean {
  if (!args.colors || args.ownerBackend !== 'posix-pty') {
    return false
  }
  const replies = terminalOscColorQueryReplies(args.colors, args.slots)
  if (!replies) {
    return false
  }
  for (const reply of replies) {
    args.delivery.answerImmediately(reply)
  }
  return true
}

export function answerStartupOscColorQuery(args: {
  slots: readonly TerminalOscColorQuerySlot[]
  intent: PtyStartupIngressIntent | undefined
  answeredSlots: Set<TerminalOscColorQuerySlot>
  delivery: ColorReplyDelivery
  onBothSlotsAnswered: () => void
}): boolean {
  if (args.slots.some((slot) => args.answeredSlots.has(slot)) || !args.intent) {
    return false
  }
  const replies = terminalOscColorQueryReplies(args.intent.colors, args.slots)
  if (!replies) {
    return false
  }

  let wroteAny = false
  for (const [index, reply] of replies.entries()) {
    const slot = args.slots[index]
    if (slot === undefined) {
      return wroteAny
    }
    args.answeredSlots.add(slot)
    // Why per slot: the replies to one query are written independently, so a
    // deferred write that fails after reporting success invalidates only its own
    // claim. Dropping every claim would let a slot that did land be answered a
    // second time, and a duplicate reply corrupts a parser already mid-read.
    if (!args.delivery.answer(reply, () => args.answeredSlots.delete(slot))) {
      args.answeredSlots.delete(slot)
      return wroteAny
    }
    wroteAny = true
  }

  if (args.answeredSlots.has(10) && args.answeredSlots.has(11)) {
    args.onBothSlotsAnswered()
  }
  return wroteAny
}
