import { useCallback, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'
import {
  chipScopes,
  pendingClipboardImages
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import {
  resolveNativeChatRuntimeSessionAttachmentOwner,
  resolveNativeChatStructuredDraftAttachmentOwner,
  type NativeChatAttachmentOwner
} from '../attachments/uploads/native-chat-attachment-owner'
import { nativeChatAttachmentOwnerUnchanged } from '../attachments/uploads/native-chat-resolved-path-ownership'
import { stageNativeChatDraftFile } from '../drafts/native-chat-draft-attachment-staging'
import { currentDraftScope } from '../drafts/native-chat-launch-draft-source'
import { structuredAgentSessionIdOfDraftScope } from '../drafts/native-chat-draft-scope'
import {
  nativeChatImagePasteFailedNotice,
  saveNativeChatPastedClipboardImage
} from './native-chat-clipboard-image-save'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'

function resolveImagePasteDestinationOwner(
  scope: string,
  mounted: boolean,
  scopedOwner?: () => NativeChatAttachmentOwner
): NativeChatAttachmentOwner | undefined {
  if (mounted && scopedOwner) {
    return scopedOwner()
  }
  const indexedOwner = resolveNativeChatStructuredDraftAttachmentOwner(scope)
  if (indexedOwner) {
    return indexedOwner
  }
  const owner = scopedOwner?.()
  return owner?.kind === 'runtime-session'
    ? resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: owner.sessionId,
        runtimeEnvironmentId: owner.environmentId
      })
    : owner
}

function imagePasteDestinationCanUsePath(
  scope: string,
  owner: NativeChatAttachmentOwner,
  current: NativeChatAttachmentOwner | undefined
): boolean {
  if (owner.kind === 'local' && owner.stagingScope !== undefined) {
    // A first-session handoff keeps the draft's local files for the existing upload-on-send path.
    return (
      (scope === owner.stagingScope &&
        current?.kind === 'local' &&
        current.stagingScope === owner.stagingScope) ||
      (structuredAgentSessionIdOfDraftScope(scope) !== null &&
        (!current || current.kind === 'local' || current.kind === 'runtime-session'))
    )
  }
  return current !== undefined && nativeChatAttachmentOwnerUnchanged(owner, current)
}

type ClipboardImagePasteOptions = Pick<
  UseNativeChatComposerPasteArgs,
  | 'attachmentScopeKey'
  | 'disabled'
  | 'resolveAttachmentOwner'
  | 'resolvePendingImageAttachment'
  | 'setNotice'
> & {
  canComplete: () => boolean
  canPaste: () => boolean
  dropImagePaste: (id: string | null) => void
}

export function useNativeChatClipboardImagePaste({
  attachmentScopeKey,
  disabled,
  resolveAttachmentOwner,
  resolvePendingImageAttachment,
  setNotice,
  canComplete,
  canPaste,
  dropImagePaste
}: ClipboardImagePasteOptions) {
  const composerRef = useRef({
    attachmentScopeKey,
    resolveAttachmentOwner,
    resolvePendingImageAttachment,
    setNotice,
    mounted: false,
    disabled
  })
  useLayoutEffect(() => {
    const composer = {
      attachmentScopeKey,
      resolveAttachmentOwner,
      resolvePendingImageAttachment,
      setNotice,
      mounted: true,
      disabled
    }
    composerRef.current = composer
    return () => {
      composer.mounted = false
    }
  }, [
    attachmentScopeKey,
    disabled,
    resolveAttachmentOwner,
    resolvePendingImageAttachment,
    setNotice
  ])

  // Return whether the original editor still owns the caret after settlement.
  return useCallback(
    async (
      owner: NativeChatAttachmentOwner,
      pendingId: string | null,
      besideText: boolean,
      ready?: () => void,
      eventImage?: Blob
    ): Promise<boolean> => {
      const saved = await saveNativeChatPastedClipboardImage(owner, {
        besideText,
        ready,
        eventImage,
        canNotify: () =>
          canComplete() && (!pendingId || pendingClipboardImages.get(pendingId) !== 'removed'),
        setNotice
      })
      if (saved.status !== 'saved') {
        dropImagePaste(pendingId)
        return false
      }

      const indexedScope = pendingId ? chipScopes.get(pendingId) : undefined
      const scope = indexedScope === undefined ? undefined : currentDraftScope(indexedScope)
      const composer = composerRef.current
      const composerScope =
        composer.attachmentScopeKey === undefined
          ? undefined
          : currentDraftScope(composer.attachmentScopeKey)
      const composerVisible = composer.mounted && !composer.disabled
      const staged = owner.kind === 'local' && owner.stagingScope !== undefined
      let reason = 'destination-lost'
      if (pendingId && pendingClipboardImages.get(pendingId) === 'removed') {
        reason = 'removed'
      } else if (pendingId && scope !== undefined) {
        const scopedOwner = composerScope === scope ? composer.resolveAttachmentOwner : undefined
        const currentOwner = resolveImagePasteDestinationOwner(scope, composer.mounted, scopedOwner)
        if (!imagePasteDestinationCanUsePath(scope, owner, currentOwner)) {
          reason = 'owner-changed'
        } else {
          const editInPlace = composerVisible && composerScope === scope && canPaste()
          const settle = editInPlace
            ? composer.resolvePendingImageAttachment
            : resolvePendingImageAttachment
          if (
            settle(
              pendingId,
              saved.tempPath,
              null,
              editInPlace ? undefined : { insertReferences: null }
            )
          ) {
            pendingClipboardImages.delete(pendingId)
            if (staged) {
              stageNativeChatDraftFile(scope, saved.tempPath)
            }
            return editInPlace
          }
        }
      }

      dropImagePaste(pendingId)
      releaseBrowserAttachmentFiles([saved.tempPath])
      console.warn('[native-chat] saved image paste dropped', reason)
      if (reason !== 'removed') {
        const notice = nativeChatImagePasteFailedNotice()
        const noticeScope =
          scope ??
          (attachmentScopeKey === undefined ? undefined : currentDraftScope(attachmentScopeKey))
        if (composerVisible && composerScope === noticeScope) {
          composer.setNotice(notice)
        } else {
          toast.error(notice)
        }
      }
      return false
    },
    [
      attachmentScopeKey,
      canComplete,
      canPaste,
      dropImagePaste,
      resolvePendingImageAttachment,
      setNotice
    ]
  )
}
