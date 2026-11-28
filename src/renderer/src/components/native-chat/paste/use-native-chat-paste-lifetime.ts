import { useCallback, useMemo } from 'react'
import { basename } from '@/lib/path'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'
import type { NativeChatReservedAttachment } from '../attachments/intake/native-chat-session-attachment-drop'
import {
  chipScopes,
  hasNativeChatPendingAttachment,
  pendingClipboardImages
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import { useNativeChatPaneLifetimeEffect } from '../pane/ownership/native-chat-pane-lifetime'
import { currentDraftScope } from '../drafts/native-chat-launch-draft-source'

/** Paste intake follows the editor lifetime; saved images follow their chips. */
export function useNativeChatPasteLifetime(args: {
  targetKey?: string
  attachmentScopeKey?: string
  /** `serverOwned`: an image the paste saved on the remote target's own server, not a client file. */
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    serverOwned?: boolean
  ) => string | null
  revealPendingImageAttachment?: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
}): {
  lifetime: { active: boolean }
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
  /** Reserve each macOS file candidate; reveal the clipboard preview and transfer retained chips to file intake for settlement. */
  startClipboardCandidateChips: (
    owner: NativeChatAttachmentOwner,
    paths: string[]
  ) => {
    reserved: NativeChatReservedAttachment[]
    reveal: () => void
    transfer: () => NativeChatReservedAttachment[]
  }
  dropImagePaste: (pendingId: string | null) => void
} {
  const {
    targetKey,
    attachmentScopeKey,
    beginPendingImageAttachment,
    revealPendingImageAttachment,
    dropPendingImageAttachment
  } = args
  const lifetime = useMemo(
    () => ({ targetKey, attachmentScopeKey, active: false }),
    [attachmentScopeKey, targetKey]
  )
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      lifetime.active = true
      return () => {
        lifetime.active = false
      }
    }, [lifetime])
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
          pendingClipboardImages.set(id, 'pending')
        }
        const reveal = (): void => {
          if (
            id &&
            lifetime.active &&
            revealPendingImageAttachment &&
            (!attachmentScopeKey || chipScopes.get(id) === currentDraftScope(attachmentScopeKey))
          ) {
            revealPendingImageAttachment(id, URL.createObjectURL(imageFile))
          }
        }
        return { id, reveal }
      }
      if (!options.canShow()) {
        return { id: null, reveal: () => {} }
      }
      const previewUrl = URL.createObjectURL(imageFile)
      const id = beginPendingImageAttachment(previewUrl, undefined, owner.kind === 'remote')
      if (id) {
        pendingClipboardImages.set(id, 'pending')
      } else {
        URL.revokeObjectURL(previewUrl)
      }
      return { id, reveal: () => {} }
    },
    [attachmentScopeKey, beginPendingImageAttachment, lifetime, revealPendingImageAttachment]
  )
  const startClipboardImageChip = useCallback(
    (
      owner: NativeChatAttachmentOwner,
      pendingName?: string
    ): { id: string | null; reveal: () => void } => {
      const id = beginPendingImageAttachment(undefined, pendingName, owner.kind === 'remote')
      if (id) {
        pendingClipboardImages.set(id, 'pending')
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
    [beginPendingImageAttachment, revealPendingImageAttachment]
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
          pendingClipboardImages.delete(chipId)
        }
        // A chip removed or cleared meanwhile starts no file work.
        return reserved.filter(
          ({ chipId }) => !attachmentScopeKey || hasNativeChatPendingAttachment(chipId)
        )
      }
      return { reserved, reveal: () => chips[0]?.reveal(), transfer }
    },
    [attachmentScopeKey, startClipboardImageChip]
  )
  const dropImagePaste = useCallback(
    (pendingId: string | null) => {
      if (pendingId) {
        pendingClipboardImages.delete(pendingId)
        dropPendingImageAttachment(pendingId)
      }
    },
    [dropPendingImageAttachment]
  )
  return {
    lifetime,
    startImageChip,
    startClipboardImageChip,
    startClipboardCandidateChips,
    dropImagePaste
  }
}
