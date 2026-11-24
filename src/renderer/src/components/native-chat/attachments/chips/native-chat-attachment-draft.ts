import type { NativeChatComposerImageAttachment } from './native-chat-image-attachment'
import {
  readNativeChatComposerDraft,
  appendToNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return readNativeChatComposerDraft(scopeKey).images.map((image) => ({ ...image }))
}

/** Persist returned images immediately; only explicit user reattachment replaces same-named unavailable placeholders. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  if (appended.length === 0) {
    return
  }
  // Preview URLs can retain the full clipboard Blob, so only the path is kept.
  appendToNativeChatComposerDraft(scopeKey, {
    images: appended.map(({ id, path, connectionId }) => ({
      id,
      path,
      ...(connectionId ? { connectionId } : {})
    })),
    ...(options?.fromUser ? { fromUser: true } : {})
  })
}
