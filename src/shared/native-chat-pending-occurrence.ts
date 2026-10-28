import { nativeChatContinuationSendText } from './native-chat-continuation-send'
import {
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from './native-chat-image-transcript-markers'
import { isImageRefBlock, type NativeChatMessage } from './native-chat-types'

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

function nativeChatUserMessageContentKey(
  message: NativeChatMessage,
  sentImagePaths?: readonly string[]
): string | null {
  if (message.role !== 'user') {
    return null
  }
  let text = normalizedNativeChatUserMessageText(message) ?? ''
  // Some CLIs retain pasted attachment paths as prompt text instead of image markers.
  const paths = sentImagePaths?.filter(Boolean) ?? []
  const normalizedPaths = paths.map(normalizeNativeChatPendingText)
  for (const prefix of [normalizedPaths.join(' '), normalizedPaths.join('')]) {
    if (prefix && (text === prefix || text.startsWith(`${prefix} `))) {
      text = text.slice(prefix.length).trimStart()
      if (!text) {
        return nativeChatPendingContentKey({ text: '', imagePaths: paths })
      }
      break
    }
  }
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
  messages: readonly NativeChatMessage[],
  sentImagePaths?: readonly string[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const key = nativeChatUserMessageContentKey(message, sentImagePaths)
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

export function advancedNativeChatUserContentCounts(
  messages: readonly NativeChatMessage[],
  sentImagePaths?: readonly string[]
): Map<string, number> {
  const advanced = new Map<string, number>()
  const waiting = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'user') {
      const key = nativeChatUserMessageContentKey(message, sentImagePaths)
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

/** Require the whole row with optional collapsed send-boundary spaces; normalized pieces make greedy matching exact. */
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

// Continuations can finish outside this queue, so only their prefix must be represented.
function countLeadingPendingTextsRepresentedByUserText(
  pieces: readonly { text: string; literal: string; continuation: boolean }[],
  userText: string
): number {
  let cursor = 0
  let opened = 0
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    if (!piece?.text) {
      return opened
    }
    const at = index > 0 && userText[cursor] === ' ' ? cursor + 1 : cursor
    const literal = piece.continuation && userText.startsWith(piece.literal, at)
    const text = literal ? piece.literal : piece.text
    if (!userText.startsWith(text, at)) {
      return opened
    }
    cursor = at + text.length
    if (
      piece.continuation &&
      !literal &&
      (cursor === userText.length || userText[cursor] === ' ')
    ) {
      opened = index + 1
    }
    if (cursor === userText.length) {
      return index > 0 ? index + 1 : opened
    }
  }
  return opened
}

/** Carry per-send boundaries from the caller; this matcher owns no clock. */
export type NativeChatGluedUserRow = {
  text: string
  /** A row may represent only sends issued before it existed. */
  representablePendingIndices: ReadonlySet<number>
}

/** Match multi-send glue and continuations here; exact single sends retain content-key/occurrence semantics. */
export function selectPendingIndicesRepresentedByUserRows(
  pending: readonly NativeChatPendingOccurrence[],
  rows: readonly NativeChatGluedUserRow[]
): Set<number> {
  const represented = new Set<number>()
  const remaining = pending.map((entry, index) => {
    const continuation = nativeChatContinuationSendText(entry.text)
    return {
      index,
      literal: normalizeNativeChatPendingText(entry.text),
      text: continuation ?? normalizeNativeChatPendingText(entry.text),
      continuation: continuation !== null
    }
  })
  if (rows.length === 0 || (pending.length < 2 && !remaining.some((entry) => entry.continuation))) {
    return represented
  }
  for (const row of rows) {
    const open: typeof remaining = []
    for (const entry of remaining) {
      if (represented.has(entry.index) || entry.text.length === 0) {
        continue
      }
      // A row predating a send ends the adjacent run; skipping it would glue across an invalid boundary.
      if (!row.representablePendingIndices.has(entry.index)) {
        break
      }
      open.push(entry)
    }
    const matched = countLeadingPendingTextsRepresentedByUserText(open, row.text)
    if (matched === 0) {
      continue
    }
    for (let i = 0; i < matched; i += 1) {
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
  // Pruning earlier echoes must not let later identical sends reuse their transcript occurrence, even after paging.
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
