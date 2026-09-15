import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
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
  const [imageAttachments, setImageAttachments] = useState<NativeChatComposerImageAttachment[]>(
    () => readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)

  const updateImageAttachments = useCallback(
    (
      updater: (
        previous: NativeChatComposerImageAttachment[]
      ) => NativeChatComposerImageAttachment[]
    ) => {
      setImageAttachments((prev) => {
        const next = updater(prev)
        writeNativeChatAttachmentCache(attachmentScopeKey, next)
        return next
      })
    },
    [attachmentScopeKey]
  )

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
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map(({ path, connectionId }) => ({
          id: nextAttachmentId(),
          path,
          connectionId: connectionId ?? undefined
        }))
      ])
    },
    [nextAttachmentId, updateImageAttachments]
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
      updateImageAttachments((prev) => [...prev, { id, path: '', previewUrl, pending: true }])
      return id
    },
    [
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      updateImageAttachments
    ]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      updateImageAttachments((prev) =>
        prev.map((attachment) =>
          attachment.id === id
            ? {
                ...attachment,
                path,
                connectionId: connectionId ?? undefined,
                pending: undefined
              }
            : attachment
        )
      )
    },
    [updateImageAttachments]
  )

  const dropPendingImageAttachment = useCallback(
    (id: string) => {
      updateImageAttachments((prev) => removeAttachmentById(prev, id))
    },
    [updateImageAttachments]
  )

  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () =>
      updateImageAttachments((prev) => {
        prev.forEach(releaseAttachmentPreview)
        return []
      }),
    flushPendingAttachments,
    removeImageAttachment: (id) => updateImageAttachments((prev) => removeAttachmentById(prev, id)),
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    dropPendingImageAttachment
  }
}

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releaseAttachmentPreview(attachment: NativeChatComposerImageAttachment): void {
  if (attachment.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

function removeAttachmentById(
  attachments: readonly NativeChatComposerImageAttachment[],
  id: string
): NativeChatComposerImageAttachment[] {
  const removed = attachments.find((attachment) => attachment.id === id)
  if (removed) {
    releaseAttachmentPreview(removed)
  }
  return attachments.filter((attachment) => attachment.id !== id)
}

const attachmentCache = new Map<string, NativeChatComposerImageAttachment[]>()

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return [...(attachmentCache.get(scopeKey) ?? [])]
}

function writeNativeChatAttachmentCache(
  scopeKey: string,
  cacheable: readonly NativeChatComposerImageAttachment[]
): void {
  // A pending chip's save resolves into THIS hook instance; restoring one into a
  // remount would strand it pending forever, so only settled chips are cached.
  const attachments = cacheable
    .values()
    .filter((attachment) => !attachment.pending)
    // Preview URLs can retain the full clipboard Blob (or a large data URL) for
    // the lifetime of the scope cache. Settled attachments reload from their
    // authorized path after a remount, so never retain the transient preview.
    .map(({ previewUrl: _previewUrl, ...attachment }) => attachment)
    .toArray()
  if (attachments.length === 0) {
    attachmentCache.delete(scopeKey)
    return
  }
  // LRU-bounded so pending attachments for permanently-removed panes can't accumulate.
  setBoundedScopeCacheEntry(attachmentCache, scopeKey, [...attachments])
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
}
