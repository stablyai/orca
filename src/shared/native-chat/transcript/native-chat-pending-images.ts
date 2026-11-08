import { isImageRefBlock, type NativeChatMessage } from '../native-chat-types'
import {
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from './native-chat-image-transcript-markers'
import type { NativeChatPendingSend } from './native-chat-pending-sends'

function nativeChatPendingImageMatchKey(pending: NativeChatPendingSend): number | null {
  const count = pending.imagePaths?.length ?? 0
  return count > 0 &&
    pending.afterMessageId !== undefined &&
    pending.delivery === undefined &&
    pending.writeUnconfirmedAt === undefined &&
    !normalizeNativeChatUserText(pending.text)
    ? count
    : null
}

/** Pathless rows cannot confirm failed or uncertain writes; reserve each row in submission order. */
export function findNativeChatPendingImageMatch(
  pending: NativeChatPendingSend,
  messages: readonly NativeChatMessage[],
  consumed: Set<string>
): { message: NativeChatMessage; advanced: boolean } | null {
  const count = nativeChatPendingImageMatchKey(pending)
  if (count === null) {
    return null
  }
  for (const [index, message] of messages.entries()) {
    if (
      message.role !== 'user' ||
      message.source !== 'transcript' ||
      normalizedNativeChatUserMessageText(message) ||
      consumed.has(message.id) ||
      pending.imageMatchExcludedMessageIds?.includes(message.id)
    ) {
      continue
    }
    const images = message.blocks.filter(isImageRefBlock)
    if (
      images.length !== count ||
      !images.every((image) => !image.path && image.url?.startsWith('data:image/'))
    ) {
      continue
    }
    consumed.add(message.id)
    return {
      message,
      advanced: messages.slice(index + 1).some((row) => row.role !== 'user')
    }
  }
  return null
}

/** Retiring an earlier send must not make its row available to the remaining echoes. */
export function retainNativeChatPendingImageClaims<T extends NativeChatPendingSend>(
  pending: readonly T[],
  remaining: T[],
  matchedImages: ReadonlyMap<T, NativeChatMessage>
): T[] {
  if (matchedImages.size === 0) {
    return remaining
  }
  const claimed = new Map<number, string[]>()
  const retained = new Set(remaining)
  return pending.flatMap((entry) => {
    const key = nativeChatPendingImageMatchKey(entry)
    const match = matchedImages.get(entry)
    if (key !== null) {
      claimed.set(key, [
        ...(claimed.get(key) ?? []),
        ...(entry.imageMatchExcludedMessageIds ?? []),
        ...(match ? [match.id] : [])
      ])
    }
    if (!retained.has(entry)) {
      return []
    }
    const excluded = key === null ? undefined : claimed.get(key)
    return [
      excluded?.length
        ? {
            ...entry,
            imageMatchExcludedMessageIds: [
              ...new Set([...(entry.imageMatchExcludedMessageIds ?? []), ...excluded])
            ]
          }
        : entry
    ]
  })
}
