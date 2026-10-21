import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { basename } from '@/lib/path'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { NativeChatReservedAttachment } from './native-chat-session-attachment-drop'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'

/**
 * Preview URLs belong to this composer; pending uploads belong to the draft's attachment cache.
 */
export function useNativeChatPasteLifetime(args: {
  targetKey?: string
  attachmentScopeKey?: string
  /** `serverOwned`: an image the paste saved on the remote target's own server, not a client file. */
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    serverOwned?: boolean
  ) => string | null
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
  /** Register the operation for the native clipboard's picture; `reveal` previews its thumbnail. */
  startClipboardImageChip: (
    owner: NativeChatAttachmentOwner,
    pendingName?: string
  ) => {
    id: string | null
    reveal: () => void
  }
  /** One chip per file a macOS paste may attach. `reveal` previews the first as the clipboard's
   *  picture; `transfer` hands the chips still in the draft to the file intake to settle. */
  startClipboardCandidateChips: (
    owner: NativeChatAttachmentOwner,
    paths: string[]
  ) => {
    reserved: NativeChatReservedAttachment[]
    reveal: () => void
    transfer: () => NativeChatReservedAttachment[]
  }
  dropImagePaste: (pendingId: string | null) => void
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
        const id = beginPendingImageAttachment(undefined, undefined, owner.kind === 'remote')
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
      const id = beginPendingImageAttachment(previewUrl, undefined, owner.kind === 'remote')
      if (id) {
        track(id, previewUrl, owner)
      } else {
        URL.revokeObjectURL(previewUrl)
      }
      return { id, reveal: () => {} }
    },
    [attachmentScopeKey, beginPendingImageAttachment, lifetime, revealPendingImageAttachment, track]
  )
  const startClipboardImageChip = useCallback(
    (
      owner: NativeChatAttachmentOwner,
      pendingName?: string
    ): { id: string | null; reveal: () => void } => {
      const id = beginPendingImageAttachment(undefined, pendingName, owner.kind === 'remote')
      if (id) {
        track(id, '', owner)
      }
      const reveal = (): void => {
        void window.api.ui
          .readClipboardImageThumbnail()
          .catch(() => null)
          .then((thumbnail) => {
            if (id && thumbnail) {
              revealPendingImageAttachment?.(id, thumbnail.dataUrl)
            }
          })
      }
      return { id, reveal }
    },
    [beginPendingImageAttachment, revealPendingImageAttachment, track]
  )
  const startClipboardCandidateChips = useCallback(
    (owner: NativeChatAttachmentOwner, paths: string[]) => {
      const chips = paths.flatMap((path) => {
        const chip = startClipboardImageChip(owner, basename(path))
        return chip.id ? [{ path, chipId: chip.id, reveal: chip.reveal }] : []
      })
      const reserved = chips.map(({ path, chipId }) => ({ path, chipId }))
      const transfer = (): NativeChatReservedAttachment[] => {
        for (const { chipId } of reserved) {
          lifetime.pending.delete(chipId)
          lifetime.uploads.delete(chipId)
        }
        // A chip removed or cleared meanwhile starts no file work.
        const current = attachmentScopeKey
          ? nativeChatPendingAttachmentSnapshot(attachmentScopeKey)
          : null
        return reserved.filter(({ chipId }) => !current || current.some(({ id }) => id === chipId))
      }
      return { reserved, reveal: () => chips[0]?.reveal(), transfer }
    },
    [attachmentScopeKey, lifetime, startClipboardImageChip]
  )
  const dropImagePaste = useCallback(
    (pendingId: string | null) => {
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        dropPendingImageAttachment(pendingId)
      }
    },
    [lifetime, dropPendingImageAttachment]
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
        resolvePendingImageAttachment(pendingId, saved.tempPath, null)
      } else {
        dropPendingImageAttachment(pendingId)
      }
      return true
    },
    [attachmentScopeKey, dropPendingImageAttachment, lifetime, resolvePendingImageAttachment]
  )
  return {
    lifetime,
    track,
    startImageChip,
    startClipboardImageChip,
    startClipboardCandidateChips,
    dropImagePaste,
    keepStoreUploadAfterUnmount
  }
}
