import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** Interleave pending chips by attachment order so completion cannot reorder thumbnails or numbers. */
export function nativeChatImageRow<T extends { id: string }>(
  images: readonly T[],
  queue: readonly NativeChatComposerImageAttachment[]
): (T | NativeChatComposerImageAttachment)[] {
  const held = new Set(images.map(({ id }) => id))
  const ahead = new Map<string, NativeChatComposerImageAttachment[]>()
  let waiting: NativeChatComposerImageAttachment[] = []
  for (const chip of queue) {
    if (held.has(chip.id)) {
      ahead.set(chip.id, waiting)
      waiting = []
    } else if (chip.pending) {
      waiting.push(chip)
    }
  }
  return [...images.flatMap((image) => [...(ahead.get(image.id) ?? []), image]), ...waiting]
}

/** A finished image stays in the queue only to keep its place behind a chip attached before it. */
export function trimSettled(
  queue: readonly NativeChatComposerImageAttachment[]
): readonly NativeChatComposerImageAttachment[] {
  const waiting = queue.findIndex((chip) => chip.pending)
  return waiting === -1 ? [] : queue.slice(waiting)
}
