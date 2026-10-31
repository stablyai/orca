// Normalize provider names at the write boundary so newlines, bidi overrides and unbounded text never enter the record.

import { sliceAtCodeUnitLimit } from '../surrogate-safe-text-slice'

/** Well past any provider's own cap, short enough that a pasted essay cannot enter the record. */
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200

/** Collapse whitespace, controls and Cf characters except U+200C/U+200D, needed by Persian, Hindi and joined emoji. Cf subtraction covers future Unicode additions; stripping tag characters degrades England/Scotland/Wales flags. Keep meaningful Braille/Hangul fillers (U+2800/U+3164/U+115F), accepting blank-looking names made solely of them. */
const UNRENDERABLE_RUN = /(?:[\s\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf})+/gu

/** Joiners survive normalization but alone, or with collapsed spaces, still form a blank label. */
const BLANK_ONLY = /^[\s\u200C\u200D]+$/u

/** With u, match only unpaired surrogates (rendered as U+FFFD), preserving both halves of astral characters. */
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
  // Cut at a character boundary to avoid a stranded high surrogate rendered as U+FFFD.
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
    value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH &&
    normalizeAgentSessionConversationName(value) === value
  )
}
