import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatAttachedHost } from './native-chat-attachment-upload'
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
  attachResolvedPaths: (paths: string[], host?: NativeChatAttachedHost) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<NativeChatComposerImageAttachment[]>(
    () => readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)
  const pendingResolvedPathsRef = useRef<{ path: string; host?: NativeChatAttachedHost }[]>([])
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

  const appendImageAttachments = useCallback(
    (paths: { path: string; host?: NativeChatAttachedHost }[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map(({ path, host }) => {
          imageAttachmentCounter.current += 1
          return {
            id: `${Date.now()}-${imageAttachmentCounter.current}`,
            path,
            connectionId: host?.connectionId ?? undefined,
            runtime: host?.runtime
          }
        })
      ])
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

  // Attach paths the TARGET AGENT can read. Every entry point resolves the
  // owning host and uploads FIRST (see native-chat-attachment-upload.ts), so
  // this funnel only ever receives owner-resolved paths — local paths for
  // local worktrees, uploaded remote paths for SSH and runtime worktrees.
  const applyResolvedPaths = useCallback(
    (
      resolvedPaths: { path: string; host?: NativeChatAttachedHost }[],
      focus: boolean,
      preserveNotice = false
    ) => {
      const target = resolveTarget()
      if (!target && !allowWithoutTarget) {
        setNotice(
          translate(
            'components.native-chat.composer.worktreeNotReady',
            'Worktree not ready — try again in a moment.'
          )
        )
        return
      }
      const imagePaths = resolvedPaths.filter(({ path }) => isNativeChatImageAttachmentPath(path))
      const filePaths = resolvedPaths
        .filter(({ path }) => !isNativeChatImageAttachmentPath(path))
        .map(({ path }) => path)
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths.map(({ path, host }) => ({ path, host })))
      insertFileReferences(filePaths)
      if (!preserveNotice) {
        setNotice(null)
      }
      if (focus && resolvedPaths.length > 0) {
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [
      allowWithoutTarget,
      appendImageAttachments,
      insertFileReferences,
      resolveTarget,
      setNotice,
      textareaRef
    ]
  )

  const attachResolvedPaths = useCallback(
    (paths: string[], host?: NativeChatAttachedHost) => {
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
        pendingResolvedPathsRef.current.push(...paths.map((path) => ({ path, host })))
        return
      }
      applyResolvedPaths(
        paths.map((path) => ({ path, host })),
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
    clearImageAttachments: () => updateImageAttachments(() => []),
    flushPendingAttachments,
    removeImageAttachment: (id) =>
      updateImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }
}

const attachmentCache = new Map<string, NativeChatComposerImageAttachment[]>()

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return [...(attachmentCache.get(scopeKey) ?? [])]
}

function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly NativeChatComposerImageAttachment[]
): void {
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
