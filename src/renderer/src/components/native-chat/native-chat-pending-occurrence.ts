import {
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from '../../../../shared/native-chat-image-transcript-markers'
import { isImageRefBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'

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
  return normalizeNativeChatUserText(text)
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
  const text = normalizedNativeChatUserMessageText(message) ?? ''
  if (text) {
    return `text:${text}`
  }
  const imagePaths = message.blocks
    .filter(isImageRefBlock)
    .map((block) => block.path)
    .filter((path): path is string => Boolean(path))
  const key = nativeChatPendingContentKey({ text: '', imagePaths })
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

/** A transcript user turn, kept identifiable so a caller can decide which
 *  pending sends it is allowed to represent. */
export type NativeChatUserRow = { id: string; text: string }

/** User rows that already have a later non-user turn (ready to prune echoes). */
export function advancedNativeChatUserRows(
  messages: readonly NativeChatMessage[]
): readonly NativeChatUserRow[] {
  const advanced: NativeChatUserRow[] = []
  const waiting: NativeChatUserRow[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = normalizedNativeChatUserMessageText(message)
      if (text) {
        waiting.push({ id: message.id, text })
      }
      continue
    }
    advanced.push(...waiting)
    waiting.length = 0
  }
  return advanced
}

/** All user rows (for hiding optimistic echoes once the turn exists). */
export function matchingNativeChatUserRows(
  messages: readonly NativeChatMessage[]
): readonly NativeChatUserRow[] {
  const rows: NativeChatUserRow[] = []
  for (const message of messages) {
    const text = normalizedNativeChatUserMessageText(message)
    if (text) {
      rows.push({ id: message.id, text })
    }
  }
  return rows
}

/**
 * How many leading pending texts concatenate to exactly `userText`, allowing at
 * most one collapsed space at each send boundary. Covers rapid-send glue
 * ("joke"+"continue" → "joke continue") while still requiring the whole row to
 * be consumed, so unrelated prefixes never match ("hi" ↛ "history").
 *
 * Greedy is exact here: both sides are whitespace-normalized, so a piece never
 * starts with a space and at most one of the two boundary forms can apply.
 */
export function countLeadingPendingTextsGluedToUserText(
  pendingTexts: readonly string[],
  userText: string
): number {
  if (pendingTexts.length === 0 || userText.length === 0) {
    return 0
  }
  let cursor = 0
  for (let index = 0; index < pendingTexts.length; index += 1) {
    const piece = pendingTexts[index]
    if (!piece) {
      return 0
    }
    if (userText.startsWith(piece, cursor)) {
      cursor += piece.length
    } else if (index > 0 && userText.startsWith(` ${piece}`, cursor)) {
      cursor += piece.length + 1
    } else {
      return 0
    }
    if (cursor === userText.length) {
      return index + 1
    }
  }
  return 0
}

/** A transcript row a glue match may consume, carrying the send boundaries it
 *  satisfies — this matcher has no clock of its own. */
export type NativeChatGluedUserRow = {
  text: string
  /** Indices into `pending` this row landed after. A row that already existed
   *  when a send was issued can never be that send's echo. */
  representablePendingIndices: ReadonlySet<number>
}

/**
 * Mark pending entries represented only by multi-send glue (2+ consecutive
 * optimistic texts concatenated into one transcript user row). Exact single
 * matches stay in the content-key/occurrence path so repeated prompts and
 * send boundaries keep their existing semantics.
 */
export function selectPendingIndicesRepresentedByUserRows(
  pending: readonly NativeChatPendingOccurrence[],
  rows: readonly NativeChatGluedUserRow[]
): Set<number> {
  const represented = new Set<number>()
  if (pending.length < 2 || rows.length === 0) {
    return represented
  }
  const remaining = pending.map((entry, index) => ({
    index,
    text: normalizeNativeChatPendingText(entry.text)
  }))
  for (const row of rows) {
    const open: typeof remaining = []
    for (const entry of remaining) {
      if (represented.has(entry.index) || entry.text.length === 0) {
        continue
      }
      // Glue consumes a leading run, so a send this row predates ends the run
      // rather than being skipped over — adjacency is what makes it glue.
      if (!row.representablePendingIndices.has(entry.index)) {
        break
      }
      open.push(entry)
    }
    const gluedCount = countLeadingPendingTextsGluedToUserText(
      open.map((entry) => entry.text),
      row.text
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
      if (at !== -1) {
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
