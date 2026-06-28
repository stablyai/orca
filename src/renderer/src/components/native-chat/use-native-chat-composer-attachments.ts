import { useCallback, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { sendNativeChatImageAttachments } from './native-chat-runtime-send'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  caret: number
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  caret,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: NativeChatComposerImageAttachment[]
  appendImageAttachments: (paths: string[]) => void
  attachLocalPaths: (paths: string[]) => void
  clearImageAttachments: () => void
  removeImageAttachment: (id: string) => void
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

  const appendImageAttachments = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map((path) => {
          imageAttachmentCounter.current += 1
          return { id: `${Date.now()}-${imageAttachmentCounter.current}`, path }
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
      setNotice(null)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [caret, setCaret, setDraft, setNotice, textareaRef]
  )

  const attachLocalPaths = useCallback(
    (paths: string[]) => {
      const target = resolveTarget()
      if (!target || nativeChatComposerTargetIsRemote(target.ptyId)) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const imagePaths = paths.filter(isNativeChatImageAttachmentPath)
      const filePaths = paths.filter((path) => !isNativeChatImageAttachmentPath(path))
      if (imagePaths.length > 0) {
        sendNativeChatImageAttachments(target.settings, target.ptyId, imagePaths)
      }
      appendImageAttachments(imagePaths)
      insertFileReferences(filePaths)
      if (imagePaths.length > 0) {
        setNotice(null)
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [appendImageAttachments, insertFileReferences, resolveTarget, setNotice, textareaRef]
  )

  return {
    imageAttachments,
    appendImageAttachments,
    attachLocalPaths,
    clearImageAttachments: () => updateImageAttachments(() => []),
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
  attachmentCache.set(scopeKey, [...attachments])
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
}
