import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const attachmentCache = new Map<string, NativeChatComposerImageAttachment[]>()

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return [...(attachmentCache.get(scopeKey) ?? [])]
}

export function writeNativeChatAttachmentCache(
  scopeKey: string,
  cacheable: readonly NativeChatComposerImageAttachment[]
): void {
  // Pending chips resolve into the current hook; only settled paths survive remounts.
  const attachments = cacheable
    .filter((attachment) => !attachment.pending)
    // Settled attachments reload from their authorized path, so don't retain transient previews.
    .map(({ previewUrl: _previewUrl, ...attachment }) => attachment)
  if (attachments.length === 0) {
    attachmentCache.delete(scopeKey)
    return
  }
  setBoundedScopeCacheEntry(attachmentCache, scopeKey, [...attachments])
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
}
