import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject
} from 'react'
import {
  nativeChatComposerTargetIsRemote,
  nativeChatLocalAttachmentUnsupportedNotice,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  isKeptLocalPaste,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachments,
  revealNativeChatPendingAttachment,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment,
  useNativeChatPendingAttachments
} from './native-chat-pending-attachment-cache'
import { appendNativeChatAttachmentCache, appendNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatComposerAttachmentPreviews } from './use-native-chat-composer-attachment-previews'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  /** False when the agent takes no image input; see `useNativeChatResolvedPathAttachments`. */
  acceptsImages?: boolean
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
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    options?: { hidden?: true }
  ) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  revealPendingImageAttachment: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => boolean
  pendingChips: NativeChatPendingAttachmentChips
} {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const settled = useSyncExternalStore(
    subscribe,
    () => readNativeChatComposerDraft(attachmentScopeKey).images
  )
  // Why: a restored paste shows only once main confirms it is still kept, so until the restore
  // check is done it waits like a chip still saving, instead of flashing before a placeholder.
  const restoring = useRestoredNativeChatComposerDraftImageCheck(attachmentScopeKey, subscribe)
  // Chips still on their way live outside the composer, so one a prompt card unmounted comes back
  // still pending and settles into the draft whichever composer is showing.
  const pending = useNativeChatPendingAttachments(attachmentScopeKey)
  const { previews, setPreview, releasePreview, releaseAllPreviews } =
    useNativeChatComposerAttachmentPreviews(settled, pending)
  const imageAttachments = useMemo(
    () => [
      ...settled.map((image) => {
        const previewUrl = previews.get(image.id)
        if (restoring && isKeptLocalPaste(image)) {
          return { ...image, pending: true }
        }
        return previewUrl ? { ...image, previewUrl } : image
      }),
      ...pending.map((chip) => {
        const previewUrl = previews.get(chip.id)
        return previewUrl ? { ...chip, previewUrl } : chip
      })
    ],
    [pending, previews, restoring, settled]
  )
  const imageAttachmentCounter = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const nextAttachmentId = useCallback((): string => {
    imageAttachmentCounter.current += 1
    return `${Date.now()}-${imageAttachmentCounter.current}`
  }, [])

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

  const appendImageAttachments = useCallback(
    (paths: { path: string; connectionId?: string | null }[]) => {
      appendNativeChatAttachmentCache(
        attachmentScopeKey,
        paths.map(({ path, connectionId }) => ({
          id: nextAttachmentId(),
          path,
          ...(connectionId ? { connectionId } : {})
        })),
        { fromUser: true }
      )
    },
    [attachmentScopeKey, nextAttachmentId]
  )

  const { attachResolvedPaths, disabledRef, flushPendingAttachments } =
    useNativeChatResolvedPathAttachments({
      acceptsImages,
      appendImageAttachments,
      attachmentTargetBlocked,
      caret,
      disabled,
      isComposing,
      noteAttachmentTargetBlocked,
      setCaret,
      setDraft,
      setNotice,
      textareaRef
    })

  // Placeholder chip shown the instant a paste starts, so a clipboard image that
  // takes a beat to save (or upload over SSH) never reads as a dropped paste.
  const beginPendingImageAttachment = useCallback(
    (previewUrl?: string, pendingName?: string, options?: { hidden?: true }): string | null => {
      // Without image input the saved paste is attached by path once it lands, so no image chip;
      // a named upload chip is a file, not an image, and still shows.
      if (disabledRef.current || (!acceptsImages && pendingName === undefined)) {
        return null
      }
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      addNativeChatPendingAttachment(attachmentScopeKey, {
        id,
        path: '',
        pending: true,
        ...(pendingName ? { pendingName } : {}),
        ...(options?.hidden ? { hidden: true } : {})
      })
      setPreview(id, previewUrl)
      return id
    },
    [
      acceptsImages,
      attachmentScopeKey,
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      setPreview
    ]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      settleNativeChatPendingAttachment(attachmentScopeKey, id, path, connectionId)
    },
    [attachmentScopeKey]
  )

  const revealPendingImageAttachment = useCallback(
    (id: string, previewUrl?: string) => {
      setPreview(id, previewUrl)
      revealNativeChatPendingAttachment(attachmentScopeKey, id)
    },
    [attachmentScopeKey, setPreview]
  )

  // A pending chip was never saved, so dropping one, even late from a replaced composer, leaves
  // the draft alone.
  const dropPendingImageAttachment = useCallback(
    (id: string): boolean => {
      releasePreview(id)
      return takeNativeChatPendingAttachment(attachmentScopeKey, id) !== undefined
    },
    [attachmentScopeKey, releasePreview]
  )

  const pendingChips = useMemo(
    (): NativeChatPendingAttachmentChips => ({
      begin: beginPendingImageAttachment,
      resolve: resolvePendingImageAttachment,
      drop: dropPendingImageAttachment,
      // At the caret, as every attach does; mid-composition or once the composer is gone, into the
      // scope's draft, which keeps it until the composition settles or the composer comes back.
      attachReferences: (paths) => {
        if (mountedRef.current && !isComposing()) {
          attachResolvedPaths(paths, null)
          return
        }
        appendNativeChatDraftCache(
          attachmentScopeKey,
          paths.map(formatNativeChatFileReference).join(' ')
        )
      }
    }),
    [
      attachResolvedPaths,
      attachmentScopeKey,
      beginPendingImageAttachment,
      dropPendingImageAttachment,
      isComposing,
      resolvePendingImageAttachment
    ]
  )

  return {
    pendingChips,
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => {
      releaseAllPreviews()
      clearNativeChatPendingAttachments(attachmentScopeKey)
      updateNativeChatComposerDraft(attachmentScopeKey, { images: [] }, 'immediate')
    },
    flushPendingAttachments,
    removeImageAttachment: (id) => {
      releasePreview(id)
      // A chip still on its way is removed before it settles, so its file never joins the message.
      if (takeNativeChatPendingAttachment(attachmentScopeKey, id)) {
        return
      }
      const images = readNativeChatComposerDraft(attachmentScopeKey).images
      updateNativeChatComposerDraft(
        attachmentScopeKey,
        { images: images.filter((image) => image.id !== id) },
        'immediate'
      )
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
