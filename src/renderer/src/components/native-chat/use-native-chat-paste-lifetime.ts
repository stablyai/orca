import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

/**
 * The pending chips of pastes this composer started, released when it unmounts or changes target.
 * A paste uploading into a paired server's store outlives the composer, which a prompt card
 * unmounts: its chip stays pending in the scope's attachment cache, where its result settles for
 * the composer's return (`native-chat-pending-attachment-cache.ts`).
 */
export function useNativeChatPasteLifetime(args: {
  targetKey?: string
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    options?: { hidden?: true }
  ) => string | null
  /** Files the result into the composer's scope even once this instance is unmounted. */
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  revealPendingImageAttachment?: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
}): {
  lifetime: { active: boolean; pending: Map<string, string> }
  track: (pendingId: string, preview: string, owner: NativeChatAttachmentOwner) => void
  /** A paste's chip, shown at once with the clipboard's own thumbnail, or held out of sight
   *  (`hidden`) until `reveal`; `id` is null when the composer refused it. */
  startImageChip: (
    owner: NativeChatAttachmentOwner,
    imageFile: Blob,
    options: { hidden: boolean; canShow: () => boolean }
  ) => { id: string | null; reveal: () => void }
  keepStoreUploadAfterUnmount: (
    pendingId: string | null,
    saved: { status: string; tempPath?: string }
  ) => boolean
} {
  const { targetKey, beginPendingImageAttachment, revealPendingImageAttachment } = args
  const { resolvePendingImageAttachment, dropPendingImageAttachment } = args
  const dropPendingRef = useRef(dropPendingImageAttachment)
  useLayoutEffect(() => {
    dropPendingRef.current = dropPendingImageAttachment
  }, [dropPendingImageAttachment])
  const lifetime = useMemo(
    () => ({
      targetKey,
      active: false,
      pending: new Map<string, string>(),
      storeUploads: new Set<string>()
    }),
    [targetKey]
  )
  useLayoutEffect(() => {
    lifetime.active = true
    return () => {
      lifetime.active = false
      for (const [id, preview] of lifetime.pending) {
        if (preview.startsWith('blob:')) {
          URL.revokeObjectURL(preview)
        }
        if (!lifetime.storeUploads.has(id)) {
          dropPendingRef.current(id)
        }
      }
      lifetime.pending.clear()
    }
  }, [lifetime])
  const track = useCallback(
    (pendingId: string, preview: string, owner: NativeChatAttachmentOwner) => {
      lifetime.pending.set(pendingId, preview)
      if (owner.kind === 'runtime-session') {
        lifetime.storeUploads.add(pendingId)
      }
    },
    [lifetime]
  )
  const startImageChip = useCallback(
    (
      owner: NativeChatAttachmentOwner,
      imageFile: Blob,
      options: { hidden: boolean; canShow: () => boolean }
    ): { id: string | null; reveal: () => void } => {
      if (options.hidden) {
        const id = beginPendingImageAttachment(undefined, undefined, { hidden: true })
        if (id) {
          track(id, '', owner)
        }
        // Through the scope's cache, so it shows even in a composer that came back since.
        const reveal = (): void => {
          if (!id) {
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
    [beginPendingImageAttachment, lifetime, revealPendingImageAttachment, track]
  )
  const keepStoreUploadAfterUnmount = useCallback(
    (pendingId: string | null, saved: { status: string; tempPath?: string }): boolean => {
      if (!pendingId || lifetime.active || !lifetime.storeUploads.has(pendingId)) {
        return false
      }
      if (saved.status === 'saved' && saved.tempPath) {
        resolvePendingImageAttachment(pendingId, saved.tempPath, null)
      } else {
        dropPendingImageAttachment(pendingId)
      }
      return true
    },
    [dropPendingImageAttachment, lifetime, resolvePendingImageAttachment]
  )
  return { lifetime, track, startImageChip, keepStoreUploadAfterUnmount }
}
