export type NativeChatComposerImageAttachment = {
  id: string
  /** Empty while `pending`: the clipboard image has no agent-readable path yet. */
  path: string
  connectionId?: string
  /** Show clipboard thumbnails immediately, without waiting for disk/upload completion. */
  previewUrl?: string
  /** True while the pasted image is still being written to disk or uploaded. */
  pending?: boolean
  /** The file's name while it uploads: a dropped or picked file, not a pasted image. */
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}

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
