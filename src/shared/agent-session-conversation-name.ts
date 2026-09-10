// The conversation name Orca recorded for one structured chat, normalized once
// at the single boundary that writes it.
//
// The text is free-form and provider-supplied, so it is bounded and flattened
// here rather than trusted: a name carrying a newline or a bidi override is not
// something the record should ever hold.

import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'

/** Well past any provider's own cap, short enough that a pasted essay cannot enter the record. */
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200

/** Whitespace, plus the C0/C1 controls, bidi controls and zero-width marks `\s`
 *  misses. A bidi override renders a label that reads as text the name does not
 *  contain, and a zero-width run renders as nothing at all. Subtracted from all
 *  of `\p{Cf}` rather than enumerated, so a format character Unicode adds later
 *  is covered with no list to remember; U+200C/U+200D are the one exception,
 *  being load-bearing in Persian, Hindi and every multi-part emoji. Accepted
 *  cost: the U+E0020-E007F tag sequences go too, so the England, Scotland and
 *  Wales flags degrade — far cheaper than an invisible payload in a label.
 *  Deliberately NOT reached: blank-RENDERING letters and marks such as U+2800,
 *  U+3164 and U+115F, which are Lo/So/Mn rather than any invisible category. A
 *  name made only of those is accepted and looks empty; Braille and the Hangul
 *  jamo fillers carry meaning in real text, so stripping them would cost more. */
const UNRENDERABLE_RUN = /(?:[\s\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf})+/gu

/** The joiners outlive the run above by design; alone — or separated only by the
 *  spaces that run collapsed to — they are still a blank label. */
const BLANK_ONLY = /^[\s\u200C\u200D]+$/u

/** A surrogate with no partner — a provider that truncated an emoji, usually.
 *  Under `u` this class matches ONLY unpaired ones, so astral characters keep
 *  both halves; left in, each renders as U+FFFD on every surface. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu

/** A cut inside an emoji sequence strands the joiner that attached it. */
const TRAILING_DANGLE = /[\s\u200C\u200D]+$/u

export function normalizeAgentSessionConversationName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  // Surrogates first, so the gap one leaves collapses with the run around it.
  const collapsed = value.replace(LONE_SURROGATE, '').replace(UNRENDERABLE_RUN, ' ').trim()
  if (!collapsed || BLANK_ONLY.test(collapsed)) {
    return null
  }
  if (collapsed.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH) {
    return collapsed
  }
  // Cut on a character boundary: a raw slice can strand a lone high surrogate,
  // which every surface then renders as U+FFFD.
  const truncated = sliceAtCodeUnitLimit(
    collapsed,
    AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  ).replace(TRAILING_DANGLE, '')
  return truncated || null
}

export function isAgentSessionConversationName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  )
}
