import { useCallback } from 'react'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'
import { stageNativeChatPendingImage } from '../../drafts/native-chat-draft-attachment-staging'
import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import { settlePendingImageReferences } from '../../composer/editor/native-chat-composer-image-references'
import type {
  NativeChatPendingAttachmentChips,
  NativeChatPendingAttachmentOptions
} from '../intake/native-chat-session-attachment-drop'
import {
  deferNativeChatPasteReference,
  settleNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import { nativeChatPendingAttachmentScope } from './native-chat-pending-attachment-scopes'

export function useNativeChatPendingImageResolution({
  attachPendingReferences,
  destinationScope,
  mountedRef,
  scopeEditor,
  serverOwnedPendingIds
}: {
  attachPendingReferences: (
    references: { id: string; path: string }[],
    options: NativeChatPendingAttachmentOptions | undefined,
    serverOwned: boolean
  ) => boolean
  destinationScope: () => string
  mountedRef: { acceptsImages: boolean }
  scopeEditor: () => NativeChatComposerInput | null
  serverOwnedPendingIds: Set<string>
}): NativeChatPendingAttachmentChips['resolve'] {
  return useCallback(
    function resolvePendingImageAttachment(
      id: string,
      path: string,
      connectionId?: string | null,
      options?: NativeChatPendingAttachmentOptions
    ): boolean {
      const stagingScope = options?.clipboardImage?.stagingScope
      if (
        options?.clipboardImage &&
        !mountedRef.acceptsImages &&
        deferNativeChatPasteReference(destinationScope(), id, {
          settle: () => resolvePendingImageAttachment(id, path, connectionId, options),
          cancel: () => {
            serverOwnedPendingIds.delete(id)
            if (stagingScope) {
              releaseBrowserAttachmentFiles([path])
            }
          }
        })
      ) {
        return true
      }
      const serverOwned = serverOwnedPendingIds.delete(id)
      if (stagingScope && !stageNativeChatPendingImage(stagingScope, id, path)) {
        return false
      }
      return mountedRef.acceptsImages
        ? settlePendingImageReferences(
            nativeChatPendingAttachmentScope(destinationScope(), id),
            scopeEditor(),
            () => settleNativeChatPendingAttachment(destinationScope(), id, path, connectionId)
          )
        : attachPendingReferences([{ id, path }], options, serverOwned)
    },
    [attachPendingReferences, destinationScope, mountedRef, scopeEditor, serverOwnedPendingIds]
  )
}
