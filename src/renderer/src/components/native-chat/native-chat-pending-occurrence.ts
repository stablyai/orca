import { stripImagePromptMarker } from '../../../../shared/native-chat-image-transcript-markers'
import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'

export type NativeChatPendingOccurrence = {
  text: string
  imagePaths?: readonly string[]
  sentAt: number
  afterMessageId?: string | null
  afterMessageTimestamp?: number | null
  matchingOccurrence?: number
  matchingAfterTimestamp?: number
}

export function normalizeNativeChatPendingText(text: string): string {
  return stripImagePromptMarker(text).trim().replace(/\s+/g, ' ')
}

export function nativeChatPendingContentKey(
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>
): string {
  const text = normalizeNativeChatPendingText(pending.text)
  if (text) {
    return `text:${text}`
  }
  const imagePaths = pending.imagePaths?.filter(Boolean) ?? []
  return imagePaths.length > 0 ? `images:${JSON.stringify(imagePaths)}` : 'empty'
}

function nativeChatUserMessageContentKey(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
  const imagePaths = message.blocks
    .filter(isImageRefBlock)
    .map((block) => block.path)
    .filter((path): path is string => Boolean(path))
  const key = nativeChatPendingContentKey({ text, imagePaths })
  return key === 'empty' ? null : key
}

export function matchingNativeChatUserContentCounts(
  messages: readonly NativeChatMessage[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const key = nativeChatUserMessageContentKey(message)
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

export function advancedNativeChatUserContentCounts(
  messages: readonly NativeChatMessage[]
): Map<string, number> {
  const advanced = new Map<string, number>()
  const waiting = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'user') {
      const key = nativeChatUserMessageContentKey(message)
      if (key) {
        waiting.set(key, (waiting.get(key) ?? 0) + 1)
      }
      continue
    }
    for (const [key, count] of waiting) {
      advanced.set(key, (advanced.get(key) ?? 0) + count)
    }
    waiting.clear()
  }
  return advanced
}

function nativeChatUserMessageNormalizedText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = normalizeNativeChatPendingText(
    message.blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join(' ')
  )
  return text.length > 0 ? text : null
}

/** User texts that already have a later non-user turn (ready to prune echoes). */
export function advancedNativeChatUserTexts(
  messages: readonly NativeChatMessage[]
): readonly string[] {
  const advanced: string[] = []
  const waiting: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = nativeChatUserMessageNormalizedText(message)
      if (text) {
        waiting.push(text)
      }
      continue
    }
    advanced.push(...waiting)
    waiting.length = 0
  }
  return advanced
}

/** All user texts (for hiding optimistic echoes once the turn exists). */
export function matchingNativeChatUserTexts(
  messages: readonly NativeChatMessage[]
): readonly string[] {
  const texts: string[] = []
  for (const message of messages) {
    const text = nativeChatUserMessageNormalizedText(message)
    if (text) {
      texts.push(text)
    }
  }
  return texts
}

/**
 * How many leading pending texts concatenate exactly to `userText`.
 * Covers rapid-send glue ("joke"+"continue" → "jokecontinue") without matching
 * unrelated prefixes ("hi" ↛ "history").
 */
export function countLeadingPendingTextsGluedToUserText(
  pendingTexts: readonly string[],
  userText: string
): number {
  if (pendingTexts.length === 0 || userText.length === 0) {
    return 0
  }
  let combined = ''
  for (let index = 0; index < pendingTexts.length; index += 1) {
    const piece = pendingTexts[index]
    if (!piece) {
      return 0
    }
    combined += piece
    if (combined === userText) {
      return index + 1
    }
    if (!userText.startsWith(combined)) {
      return 0
    }
  }
  return 0
}

/**
 * Mark pending entries represented only by multi-send glue (2+ consecutive
 * optimistic texts concatenated into one transcript user row). Exact single
 * matches stay in the content-key/occurrence path so repeated prompts and
 * send boundaries keep their existing semantics.
 */
export function selectPendingIndicesRepresentedByUserTexts(
  pending: readonly NativeChatPendingOccurrence[],
  userTexts: readonly string[]
): Set<number> {
  const represented = new Set<number>()
  if (pending.length < 2 || userTexts.length === 0) {
    return represented
  }
  const remaining = pending.map((entry, index) => ({
    index,
    text: normalizeNativeChatPendingText(entry.text)
  }))
  for (const userText of userTexts) {
    const open = remaining.filter((entry) => !represented.has(entry.index) && entry.text.length > 0)
    const gluedCount = countLeadingPendingTextsGluedToUserText(
      open.map((entry) => entry.text),
      userText
    )
    // Why: gluedCount === 1 is an exact match — leave it to occurrence counting.
    if (gluedCount < 2) {
      continue
    }
    for (let i = 0; i < gluedCount; i += 1) {
      const entry = open[i]
      if (!entry) {
        continue
      }
      represented.add(entry.index)
      const at = remaining.findIndex((candidate) => candidate.index === entry.index)
      if (at >= 0) {
        remaining.splice(at, 1)
      }
    }
  }
  return represented
}

export function nativeChatPendingMatchKey(pending: NativeChatPendingOccurrence): string {
  return `${String(pending.afterMessageId)}\0${nativeChatPendingContentKey(pending)}`
}

export function assignNativeChatPendingOccurrence<T extends NativeChatPendingOccurrence>(
  existing: readonly T[],
  entry: T
): T {
  const key = nativeChatPendingMatchKey(entry)
  const matching = existing.filter((candidate) => nativeChatPendingMatchKey(candidate) === key)
  if (matching.length === 0) {
    return entry
  }
  const previousOccurrence = Math.max(
    ...matching.map((candidate, index) => candidate.matchingOccurrence ?? index + 1)
  )
  const first = matching[0]
  // Why: pruning an earlier echo must not let a later identical send reuse the
  // same transcript occurrence, even after the read pages out its boundary.
  return {
    ...entry,
    matchingOccurrence: previousOccurrence + 1,
    matchingAfterTimestamp:
      first?.matchingAfterTimestamp ?? first?.afterMessageTimestamp ?? first?.sentAt
  }
}

export function nativeChatPendingMatchingAfter(pending: NativeChatPendingOccurrence): number {
  return pending.matchingAfterTimestamp ?? pending.afterMessageTimestamp ?? pending.sentAt
}

export function nativeChatPendingOccurrence(
  pending: NativeChatPendingOccurrence,
  alreadyConsumed: number
): number {
  return pending.matchingOccurrence ?? alreadyConsumed + 1
}
