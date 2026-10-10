import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'

/**
 * Preview URLs belong to this composer; pending uploads belong to the draft's attachment cache.
 */
export function useNativeChatPasteLifetime(args: {
  targetKey?: string
  attachmentScopeKey?: string
  beginPendingImageAttachment: (previewUrl?: string, pendingName?: string) => string | null
  /** Files the result into the composer's scope even once this instance is unmounted. */
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  revealPendingImageAttachment?: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
}): {
  lifetime: { active: boolean; pending: Map<string, string> }
  track: (pendingId: string, preview: string, owner: NativeChatAttachmentOwner) => void
  /** Register the visible operation; `reveal` supplies its preview once the host accepts it. */
  startImageChip: (
    owner: NativeChatAttachmentOwner,
    imageFile: Blob,
    options: { deferPreview: boolean; canShow: () => boolean }
  ) => { id: string | null; reveal: () => void }
  keepStoreUploadAfterUnmount: (
    pendingId: string | null,
    saved: { status: string; tempPath?: string }
  ) => boolean
} {
  const {
    targetKey,
    attachmentScopeKey,
    beginPendingImageAttachment,
    revealPendingImageAttachment
  } = args
  const { resolvePendingImageAttachment, dropPendingImageAttachment } = args
  const dropPendingRef = useRef(dropPendingImageAttachment)
  useLayoutEffect(() => {
    dropPendingRef.current = dropPendingImageAttachment
  }, [dropPendingImageAttachment])
  const lifetime = useMemo(
    () => ({
      targetKey,
      attachmentScopeKey,
      active: false,
      pending: new Map<string, string>(),
      uploads: new Map<string, NativeChatAttachmentOwner>()
    }),
    [attachmentScopeKey, targetKey]
  )
  useLayoutEffect(() => {
    lifetime.active = true
    return () => {
      lifetime.active = false
      for (const [id, preview] of lifetime.pending) {
        if (preview.startsWith('blob:')) {
          URL.revokeObjectURL(preview)
        }
        if (
          lifetime.uploads.get(id)?.kind !== 'runtime-session' &&
          !(
            attachmentScopeKey &&
            nativeChatPendingAttachmentSnapshot(attachmentScopeKey).some((chip) => chip.id === id)
          )
        ) {
          dropPendingRef.current(id)
        }
      }
      lifetime.pending.clear()
    }
  }, [attachmentScopeKey, lifetime])
  const track = useCallback(
    (pendingId: string, preview: string, owner: NativeChatAttachmentOwner) => {
      lifetime.pending.set(pendingId, preview)
      lifetime.uploads.set(pendingId, owner)
    },
    [lifetime]
  )
  const startImageChip = useCallback(
    (
      owner: NativeChatAttachmentOwner,
      imageFile: Blob,
      options: { deferPreview: boolean; canShow: () => boolean }
    ): { id: string | null; reveal: () => void } => {
      if (options.deferPreview) {
        const id = beginPendingImageAttachment()
        if (id) {
          track(id, '', owner)
        }
        // Through the scope's cache, so it shows even in a composer that came back since.
        const reveal = (): void => {
          if (
            !id ||
            (attachmentScopeKey &&
              !nativeChatPendingAttachmentSnapshot(attachmentScopeKey).some(
                (chip) => chip.id === id
              ))
          ) {
            return
          }
          const previewUrl = lifetime.active ? URL.createObjectURL(imageFile) : undefined
          if (previewUrl) {
            lifetime.pending.set(id, previewUrl)
          }
          revealPendingImageAttachment?.(id, previewUrl)
        }
        return { id, reveal }
      }
      if (!options.canShow()) {
        return { id: null, reveal: () => {} }
      }
      const previewUrl = URL.createObjectURL(imageFile)
      const id = beginPendingImageAttachment(previewUrl)
      if (id) {
        track(id, previewUrl, owner)
      } else {
        URL.revokeObjectURL(previewUrl)
      }
      return { id, reveal: () => {} }
    },
    [attachmentScopeKey, beginPendingImageAttachment, lifetime, revealPendingImageAttachment, track]
  )
  const keepStoreUploadAfterUnmount = useCallback(
    (pendingId: string | null, saved: { status: string; tempPath?: string }): boolean => {
      if (!pendingId || lifetime.active) {
        if (pendingId) {
          lifetime.uploads.delete(pendingId)
        }
        return false
      }
      const owner = lifetime.uploads.get(pendingId)
      if (
        owner?.kind !== 'runtime-session' &&
        !(
          attachmentScopeKey &&
          nativeChatPendingAttachmentSnapshot(attachmentScopeKey).some(
            (chip) => chip.id === pendingId
          )
        )
      ) {
        lifetime.uploads.delete(pendingId)
        return false
      }
      lifetime.uploads.delete(pendingId)
      if (saved.status === 'saved' && saved.tempPath) {
        resolvePendingImageAttachment(
          pendingId,
          saved.tempPath,
          owner?.kind === 'ssh' ? owner.connectionId : null
        )
      } else {
        dropPendingImageAttachment(pendingId)
      }
      return true
    },
    [attachmentScopeKey, dropPendingImageAttachment, lifetime, resolvePendingImageAttachment]
  )
  return { lifetime, track, startImageChip, keepStoreUploadAfterUnmount }
}
