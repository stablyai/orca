import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
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
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
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
  const pendingResolvedPathsRef = useRef<{ path: string; connectionId?: string | null }[]>([])
  const pendingPathLimitRejectedRef = useRef(false)
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      pendingResolvedPathsRef.current = []
      pendingPathLimitRejectedRef.current = false
    }
  }, [disabled])

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

  // Local paths are only attachable when the composer's target runs locally;
  // remote-runtime panes read a different filesystem than the one we resolved.
  const attachmentTargetBlocked = useCallback((): boolean => {
    const target = resolveTarget()
    return (
      (!target && !allowWithoutTarget) ||
      Boolean(target && nativeChatComposerTargetIsRemote(target.ptyId))
    )
  }, [allowWithoutTarget, resolveTarget])

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
    [attachmentTargetBlocked, nextAttachmentId, noteAttachmentTargetBlocked, updateImageAttachments]
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

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      const references = paths.map(formatNativeChatFileReference).join(' ')
      if (references.length === 0) {
        return
      }
      const insertion = `${references} `
      const caretAtInsert = textareaRef.current?.selectionStart ?? caret
      setDraft((prev) => {
        const before = prev.slice(0, caretAtInsert)
        const after = prev.slice(caretAtInsert)
        const next = before + insertion + after
        setCaret(before.length + insertion.length)
        return next
      })
    },
    [caret, setCaret, setDraft, textareaRef]
  )

  // Attach paths the TARGET AGENT can read: local paths for local worktrees,
  // already-uploaded remote paths for SSH worktrees (the composer uploads
  // before calling this — see native-chat-attachment-upload.ts).
  const applyResolvedPaths = useCallback(
    (
      resolvedPaths: { path: string; connectionId?: string | null }[],
      focus: boolean,
      preserveNotice = false
    ) => {
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return
      }
      const imagePaths = resolvedPaths.filter(({ path }) => isNativeChatImageAttachmentPath(path))
      const filePaths = resolvedPaths
        .filter(({ path }) => !isNativeChatImageAttachmentPath(path))
        .map(({ path }) => path)
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths.map(({ path, connectionId }) => ({ path, connectionId })))
      insertFileReferences(filePaths)
      if (!preserveNotice) {
        setNotice(null)
      }
      if (focus && resolvedPaths.length > 0) {
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [
      appendImageAttachments,
      attachmentTargetBlocked,
      insertFileReferences,
      noteAttachmentTargetBlocked,
      setNotice,
      textareaRef
    ]
  )

  const attachResolvedPaths = useCallback(
    (paths: string[], connectionId?: string | null) => {
      if (paths.length === 0 || disabledRef.current) {
        return
      }
      if (isComposing()) {
        if (paths.length > NATIVE_FILE_DROP_MAX_PATHS - pendingResolvedPathsRef.current.length) {
          // Reject the whole completion so ordered path batches are never partially applied.
          pendingPathLimitRejectedRef.current = true
          setNotice(
            translate(
              'components.native-chat.composer.pendingAttachmentLimit',
              'Too many attachments are waiting. Finish composing before attaching more.'
            )
          )
          return
        }
        pendingResolvedPathsRef.current.push(...paths.map((path) => ({ path, connectionId })))
        return
      }
      applyResolvedPaths(
        paths.map((path) => ({ path, connectionId })),
        true
      )
    },
    [applyResolvedPaths, isComposing, setNotice]
  )

  const flushPendingAttachments = useCallback(() => {
    const paths = pendingResolvedPathsRef.current
    const preserveNotice = pendingPathLimitRejectedRef.current
    pendingResolvedPathsRef.current = []
    pendingPathLimitRejectedRef.current = false
    if (paths.length === 0 || disabledRef.current) {
      return
    }
    applyResolvedPaths(paths, false, preserveNotice)
  }, [applyResolvedPaths])

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
    .filter((attachment) => !attachment.pending)
    // Preview URLs can retain the full clipboard Blob (or a large data URL) for
    // the lifetime of the scope cache. Settled attachments reload from their
    // authorized path after a remount, so never retain the transient preview.
    .map(({ previewUrl: _previewUrl, ...attachment }) => attachment)
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
