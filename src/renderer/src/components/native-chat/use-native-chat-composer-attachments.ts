import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import {
  nativeChatComposerTargetIsRemote,
  nativeChatLocalAttachmentUnsupportedNotice,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { updateNativeChatComposerDraft } from './native-chat-composer-draft-store'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'
import type {
  NativeChatPendingAttachmentChips,
  NativeChatPendingAttachmentOptions
} from './native-chat-session-attachment-drop'
import {
  addNativeChatPendingAttachment,
  appendNativeChatAttachmentsAfterPending,
  clearNativeChatPendingAttachments,
  settleNativeChatPendingAttachment,
  settleNativeChatPendingAttachmentReferences,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'
import { useNativeChatComposerImageChips } from './use-native-chat-composer-image-chips'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import {
  insertImageReferences,
  nativeChatImageRowIds,
  removeImageWithReferences,
  settlePendingImageReferences,
  takePendingImageWithReferences
} from './native-chat-composer-image-references'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import { useNativeChatPastedTextAdmission } from './native-chat-pasted-text-state'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  /** False when the agent takes no image input; see `useNativeChatResolvedPathAttachments`. */
  acceptsImages?: boolean
  /** Structured chats only: each image gets a chip in the prompt where it was attached. */
  imageReferences?: boolean
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<NativeChatComposerInput | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  acceptsImages = true,
  imageReferences = false,
  allowWithoutTarget = false,
  caret,
  disabled,
  isComposing,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: NativeChatComposerImageAttachment[]
  /** A long paste in this scope is still being saved as a file; Send waits for it. */
  pastedTextSaving: boolean
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
  /** `serverOwned`: an image the paste saved on the remote target's own server, not a client file. */
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    serverOwned?: boolean
  ) => string | null
  resolvePendingImageAttachment: NativeChatPendingAttachmentChips['resolve']
  revealPendingImageAttachment: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => boolean
  pendingChips: NativeChatPendingAttachmentChips
  /** The editor while it shows this scope; null once it went or shows another. */
  scopeEditor: () => NativeChatComposerInput | null
} {
  const { imageAttachments, setPreview, releasePreview, releaseAllPreviews } =
    useNativeChatComposerImageChips(attachmentScopeKey)
  const mountedRef = useMemo(
    () => ({ scopeKey: attachmentScopeKey, current: true, acceptsImages: true }),
    [attachmentScopeKey]
  )
  // Captured callbacks retain this scope's last committed capability after unmount.
  useLayoutEffect(() => {
    mountedRef.acceptsImages = acceptsImages
  }, [acceptsImages, mountedRef])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [mountedRef])

  const nextAttachmentId = useCallback(() => createUuidV4(), [])
  const serverOwnedPendingIds = useMemo(() => new Set<string>(), [])

  // Client-local paths cannot cross into a runtime target; workspace-owned
  // paths may only bypass this after the internal drop ownership gate.
  const attachmentTargetBlocked = useCallback(
    (targetOwned = false): boolean => {
      const target = resolveTarget()
      return (
        (!target && !allowWithoutTarget) ||
        Boolean(target && nativeChatComposerTargetIsRemote(target.ptyId) && !targetOwned)
      )
    },
    [allowWithoutTarget, resolveTarget]
  )

  const noteAttachmentTargetBlocked = useCallback(() => {
    setNotice(nativeChatLocalAttachmentUnsupportedNotice())
  }, [setNotice])

  // Why the scope's own editor: an upload outlives a switch to another conversation, which the
  // editor then shows; this scope's chips are then in its stored draft.
  const scopeEditor = useCallback(
    () => (mountedRef.current ? textareaRef.current : null),
    [mountedRef, textareaRef]
  )
  useLayoutEffect(() => {
    if (disabled) {
      settlePendingImageReferences(attachmentScopeKey, scopeEditor(), () =>
        clearNativeChatPendingAttachments(attachmentScopeKey)
      )
    }
  }, [attachmentScopeKey, disabled, scopeEditor])

  const appendImageAttachments = useCallback(
    (paths: { path: string; connectionId?: string | null }[]) => {
      const images = paths.map(({ path, connectionId }) => ({
        id: nextAttachmentId(),
        path,
        ...(connectionId ? { connectionId } : {})
      }))
      appendNativeChatAttachmentsAfterPending(attachmentScopeKey, images, { fromUser: true })
      if (!imageReferences) {
        return
      }
      // One that took an unavailable image's place keeps that image's id, and so its chips.
      const row = nativeChatImageRowIds(attachmentScopeKey)
      insertImageReferences(
        attachmentScopeKey,
        scopeEditor(),
        images.flatMap(({ id }) => (row.includes(id) ? [id] : []))
      )
    },
    [attachmentScopeKey, imageReferences, nextAttachmentId, scopeEditor]
  )

  const { attachResolvedPaths, disabledRef, flushPendingAttachments } =
    useNativeChatResolvedPathAttachments({
      acceptsImages,
      appendImageAttachments,
      attachmentTargetBlocked,
      caret,
      disabled,
      isComposing,
      mountedRef,
      noteAttachmentTargetBlocked,
      setCaret,
      setDraft,
      setNotice,
      textareaRef
    })

  // Placeholder chip shown the instant a paste starts, so a clipboard image that
  // takes a beat to save (or upload over SSH) never reads as a dropped paste.
  const beginPendingImageAttachment = useCallback(
    (previewUrl?: string, pendingName?: string, serverOwned = false): string | null => {
      if (disabledRef.current) {
        return null
      }
      if (attachmentTargetBlocked(serverOwned)) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      if (serverOwned) {
        serverOwnedPendingIds.add(id)
      }
      addNativeChatPendingAttachment(attachmentScopeKey, {
        id,
        path: '',
        pending: true,
        ...(pendingName ? { pendingName } : {})
      })
      setPreview(id, previewUrl)
      // A dropped file's kind shows in its name; a clipboard paste is always an image.
      if (
        imageReferences &&
        acceptsImages &&
        (!pendingName || isNativeChatImageAttachmentPath(pendingName))
      ) {
        insertImageReferences(attachmentScopeKey, scopeEditor(), [id])
      }
      return id
    },
    [
      acceptsImages,
      attachmentScopeKey,
      attachmentTargetBlocked,
      disabledRef,
      imageReferences,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      scopeEditor,
      serverOwnedPendingIds,
      setPreview
    ]
  )

  const attachPendingReferences = useCallback(
    (
      references: { id: string; path: string }[],
      options?: NativeChatPendingAttachmentOptions,
      serverOwned = false
    ) =>
      settlePendingImageReferences(attachmentScopeKey, scopeEditor(), () =>
        settleNativeChatPendingAttachmentReferences(
          attachmentScopeKey,
          references,
          options?.insertReferences !== undefined
            ? (options.insertReferences ?? undefined)
            : mountedRef.current && !disabledRef.current && !isComposing()
              ? (paths) =>
                  // The paste re-checked the owner just before settling a server-owned image.
                  attachResolvedPaths(
                    paths,
                    null,
                    serverOwned ? { ...options, targetOwnerIsCurrent: () => true } : options
                  )
              : undefined
        )
      ),
    [attachResolvedPaths, attachmentScopeKey, disabledRef, isComposing, mountedRef, scopeEditor]
  )

  const resolvePendingImageAttachment = useCallback(
    (
      id: string,
      path: string,
      connectionId?: string | null,
      options?: NativeChatPendingAttachmentOptions
    ) => {
      const serverOwned = serverOwnedPendingIds.delete(id)
      return mountedRef.acceptsImages
        ? settlePendingImageReferences(attachmentScopeKey, scopeEditor(), () =>
            settleNativeChatPendingAttachment(attachmentScopeKey, id, path, connectionId)
          )
        : attachPendingReferences([{ id, path }], options, serverOwned)
    },
    [attachPendingReferences, attachmentScopeKey, mountedRef, scopeEditor, serverOwnedPendingIds]
  )

  const revealPendingImageAttachment = useCallback(
    (id: string, previewUrl?: string) => {
      if (nativeChatPendingAttachmentSnapshot(attachmentScopeKey).some((chip) => chip.id === id)) {
        setPreview(id, previewUrl)
      }
    },
    [attachmentScopeKey, setPreview]
  )

  // A pending chip was never saved, so dropping one, even late from a replaced composer, leaves
  // the draft alone.
  const dropPendingImageAttachment = useCallback(
    (id: string): boolean => {
      releasePreview(id)
      serverOwnedPendingIds.delete(id)
      return takePendingImageWithReferences(attachmentScopeKey, scopeEditor(), id) !== undefined
    },
    [attachmentScopeKey, releasePreview, scopeEditor, serverOwnedPendingIds]
  )

  const pendingChips = useMemo(
    (): NativeChatPendingAttachmentChips => ({
      begin: beginPendingImageAttachment,
      resolve: resolvePendingImageAttachment,
      drop: dropPendingImageAttachment,
      // At the caret, as every attach does; mid-composition or once the composer is gone, into the
      // scope's draft, which keeps it until the composition settles or the composer comes back.
      attachReferences: attachPendingReferences
    }),
    [
      attachPendingReferences,
      beginPendingImageAttachment,
      dropPendingImageAttachment,
      resolvePendingImageAttachment
    ]
  )

  const pastedTextSaving = useNativeChatPastedTextAdmission(attachmentScopeKey) === 'saving'

  return {
    pendingChips,
    scopeEditor,
    imageAttachments,
    pastedTextSaving,
    attachResolvedPaths,
    clearImageAttachments: () => {
      releaseAllPreviews()
      clearNativeChatPendingAttachments(attachmentScopeKey)
      updateNativeChatComposerDraft(attachmentScopeKey, { images: [] }, 'immediate')
    },
    flushPendingAttachments,
    removeImageAttachment: (id) => {
      releasePreview(id)
      removeImageWithReferences(attachmentScopeKey, scopeEditor(), id)
    },
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    revealPendingImageAttachment,
    dropPendingImageAttachment
  }
}

export {
  readNativeChatAttachmentCache,
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests
} from './native-chat-draft-cache'
