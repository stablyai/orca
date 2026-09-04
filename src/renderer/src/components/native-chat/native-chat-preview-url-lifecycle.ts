import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** Track object URLs owned by one composer so cleanup is idempotent. */
export function createPreviewUrlRegistry(
  attachments: readonly NativeChatComposerImageAttachment[]
): Set<string> {
  return new Set(
    attachments.flatMap((attachment) =>
      attachment.previewUrl?.startsWith('blob:') ? [attachment.previewUrl] : []
    )
  )
}

export function trackPreviewUrl(url: string | undefined, registry: Set<string>): void {
  if (url?.startsWith('blob:')) {
    registry.add(url)
  }
}

export function releaseAttachmentPreview(
  attachment: NativeChatComposerImageAttachment,
  registry: Set<string>
): void {
  if (attachment.previewUrl?.startsWith('blob:') && registry.delete(attachment.previewUrl)) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export function removeAttachmentById(
  attachments: readonly NativeChatComposerImageAttachment[],
  id: string,
  registry: Set<string>
): NativeChatComposerImageAttachment[] {
  const removed = attachments.find((attachment) => attachment.id === id)
  if (removed) {
    releaseAttachmentPreview(removed, registry)
  }
  return attachments.filter((attachment) => attachment.id !== id)
}
