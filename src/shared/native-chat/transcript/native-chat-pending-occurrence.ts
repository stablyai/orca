import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import {
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from './native-chat-image-transcript-markers'
import { isImageRefBlock, type NativeChatMessage } from '../native-chat-types'

export type NativeChatPendingOccurrence = {
  sourceAgent?: AgentType
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
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths' | 'sourceAgent'>
): string {
  if (pending.sourceAgent) {
    return `request:${JSON.stringify([pending.sourceAgent, pending.text, pending.imagePaths ?? []])}`
  }
  const text = normalizeNativeChatPendingText(pending.text)
  if (text) {
    return `text:${text}`
  }
  const imagePaths = pending.imagePaths?.filter(Boolean) ?? []
  return imagePaths.length > 0 ? `images:${JSON.stringify(imagePaths)}` : 'empty'
}

export function nativeChatUserMessageContentKey(
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

export {
  countLeadingPendingTextsGluedToUserText,
  selectPendingIndicesRepresentedByUserRows,
  type NativeChatGluedUserRow
} from './native-chat-pending-glue'
