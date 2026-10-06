import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from 'react'
import { translate } from '@/i18n/i18n'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  isKeptLocalPaste,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
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
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
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
  // Chips still being written, and the clipboard previews this composer minted, are its own.
  const [local, setLocal] = useState<LocalAttachments>(NO_LOCAL_ATTACHMENTS)
  // Read by callbacks between renders; only they change it, always together with the state.
  const localRef = useRef(local)
  const updateLocal = useCallback((next: LocalAttachments) => {
    localRef.current = next
    setLocal(next)
  }, [])
  const imageAttachments = useMemo(
    () => [
      ...settled.map((image) => {
        const previewUrl = local.previews.get(image.id)
        if (restoring && isKeptLocalPaste(image)) {
          return { ...image, pending: true }
        }
        return previewUrl ? { ...image, previewUrl } : image
      }),
      ...local.pending
    ],
    [local, restoring, settled]
  )
  // A preview whose image left the draft (sent, or removed elsewhere) is released.
  useEffect(() => {
    const current = localRef.current
    const gone = [...current.previews.keys()].filter(
      (id) => !settled.some((image) => image.id === id)
    )
    if (gone.length === 0) {
      return
    }
    const previews = new Map(current.previews)
    for (const id of gone) {
      releasePreviewUrl(previews.get(id))
      previews.delete(id)
    }
    updateLocal({ ...current, previews })
  }, [settled, updateLocal])
  const imageAttachmentCounter = useRef(0)

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
    setNotice(
      translate(
        'components.native-chat.composer.localAttachmentUnsupported',
        'Local attachments are not available for remote sessions.'
      )
    )
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
    (previewUrl?: string): string | null => {
      if (disabledRef.current) {
        return null
      }
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      const current = localRef.current
      updateLocal({
        ...current,
        pending: [...current.pending, { id, path: '', previewUrl, pending: true }]
      })
      return id
    },
    [
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      updateLocal
    ]
  )

  /** Drops this composer's own copy of a chip; the store is not touched. */
  const forgetLocalAttachment = useCallback(
    (id: string, keepPreview = false): NativeChatComposerImageAttachment | undefined => {
      const current = localRef.current
      const pending = current.pending.find((attachment) => attachment.id === id)
      const previewUrl = pending?.previewUrl ?? current.previews.get(id)
      if (!pending && previewUrl === undefined) {
        return undefined
      }
      const previews = new Map(current.previews)
      previews.delete(id)
      if (keepPreview && previewUrl) {
        previews.set(id, previewUrl)
      } else {
        releasePreviewUrl(previewUrl)
      }
      updateLocal({
        pending: current.pending.filter((attachment) => attachment.id !== id),
        previews
      })
      return pending
    },
    [updateLocal]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      if (forgetLocalAttachment(id, true)) {
        appendNativeChatAttachmentCache(
          attachmentScopeKey,
          [{ id, path, ...(connectionId ? { connectionId } : {}) }],
          { fromUser: true }
        )
      }
    },
    [attachmentScopeKey, forgetLocalAttachment]
  )

  // A pending chip was never saved, so dropping one, even late from a replaced composer, leaves
  // the store alone.
  const dropPendingImageAttachment = useCallback(
    (id: string) => {
      forgetLocalAttachment(id)
    },
    [forgetLocalAttachment]
  )

  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => {
      const current = localRef.current
      current.pending.forEach((attachment) => releasePreviewUrl(attachment.previewUrl))
      current.previews.forEach(releasePreviewUrl)
      updateLocal(NO_LOCAL_ATTACHMENTS)
      updateNativeChatComposerDraft(attachmentScopeKey, { images: [] }, 'immediate')
    },
    flushPendingAttachments,
    removeImageAttachment: (id) => {
      if (forgetLocalAttachment(id)) {
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
    dropPendingImageAttachment
  }
}

type LocalAttachments = {
  pending: NativeChatComposerImageAttachment[]
  previews: ReadonlyMap<string, string>
}

const NO_LOCAL_ATTACHMENTS: LocalAttachments = { pending: [], previews: new Map() }

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releasePreviewUrl(previewUrl: string | undefined): void {
  if (previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return readNativeChatComposerDraft(scopeKey).images.map((image) => ({ ...image }))
}

/** Adds settled images after the ones the draft holds now, durably at once: when Stop gives images
 *  back, the copy they came from goes right after this. Only an image the user attaches
 *  (`fromUser`) takes the place of a placeholder with its file name, as a re-pick does. */
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

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
}
