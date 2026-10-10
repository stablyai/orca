import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import { nativeChatAttachmentOwnerChangedNotice } from './native-chat-attachment-upload'
import {
  nativeChatWorkspaceAttachmentMismatchNotice,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'

type ResolvedAttachmentPath = {
  path: string
  connectionId?: string | null
} & NativeChatResolvedPathOptions

type Args = {
  /** False when the agent takes no image input: an image is then referenced by path like any file. */
  acceptsImages?: boolean
  appendImageAttachments: (paths: { path: string; connectionId?: string | null }[]) => void
  attachmentTargetBlocked: (targetOwned?: boolean) => boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  noteAttachmentTargetBlocked: () => void
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
  textareaRef: RefObject<NativeChatComposerInput | null>
}

export function useNativeChatResolvedPathAttachments({
  acceptsImages = true,
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
}: Args): {
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  disabledRef: RefObject<boolean>
  flushPendingAttachments: () => void
} {
  const pendingResolvedBatchesRef = useRef<ResolvedAttachmentPath[][]>([])
  const pendingPathLimitRejectedRef = useRef(false)
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      pendingResolvedBatchesRef.current = []
      pendingPathLimitRejectedRef.current = false
    }
  }, [disabled])

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      const input = textareaRef.current
      // The editor shows each file as a pill and reports the new draft and caret itself.
      if (input?.insertFileReferences) {
        input.insertFileReferences(paths)
        return
      }
      const insertion = `${paths.map(formatNativeChatFileReference).join(' ')} `
      const caretAtInsert = input?.selectionStart ?? caret
      setDraft((prev) => {
        const before = prev.slice(0, caretAtInsert)
        const after = prev.slice(caretAtInsert)
        setCaret(before.length + insertion.length)
        return before + insertion + after
      })
    },
    [caret, setCaret, setDraft, textareaRef]
  )

  const resolvedBatchIsCurrent = useCallback(
    (resolvedPaths: ResolvedAttachmentPath[]): boolean => {
      if (resolvedPaths.some(({ destinationIsCurrent }) => destinationIsCurrent?.() === false)) {
        setNotice(nativeChatAttachmentOwnerChangedNotice())
        return false
      }
      if (resolvedPaths.some(({ targetOwnerIsCurrent }) => targetOwnerIsCurrent?.() === false)) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return false
      }
      return true
    },
    [setNotice]
  )

  const applyResolvedPaths = useCallback(
    (resolvedPaths: ResolvedAttachmentPath[], focus: boolean, preserveNotice = false) => {
      if (resolvedPaths.length === 0 || !resolvedBatchIsCurrent(resolvedPaths)) {
        return
      }
      // Ownership is per path, so the verdict is too: a queued batch can mix a
      // workspace drop the target owns with a client-local paste it does not,
      // and one verdict for the batch would refuse the drop the user can make.
      const ownedBlocked =
        resolvedPaths.some(({ targetOwnerIsCurrent }) => targetOwnerIsCurrent) &&
        attachmentTargetBlocked(true)
      const clientLocalBlocked =
        resolvedPaths.some(({ targetOwnerIsCurrent }) => !targetOwnerIsCurrent) &&
        attachmentTargetBlocked(false)
      // Filter rather than partition: the two halves are interleaved, and these
      // references are inserted in the order the user attached them.
      const attachable = resolvedPaths.filter(({ targetOwnerIsCurrent }) =>
        targetOwnerIsCurrent ? !ownedBlocked : !clientLocalBlocked
      )
      if (attachable.length === 0) {
        noteAttachmentTargetBlocked()
        return
      }
      const attachesAsImage = (path: string): boolean =>
        acceptsImages && isNativeChatImageAttachmentPath(path)
      const imagePaths = attachable.filter(({ path }) => attachesAsImage(path))
      const filePaths = attachable
        .filter(({ path }) => !attachesAsImage(path))
        .map(({ path }) => path)
      // Images ride along on submit so chips and the TUI input cannot diverge.
      appendImageAttachments(imagePaths.map(({ path, connectionId }) => ({ path, connectionId })))
      insertFileReferences(filePaths)
      if (ownedBlocked || clientLocalBlocked) {
        noteAttachmentTargetBlocked()
      } else if (!preserveNotice) {
        setNotice(null)
      }
      if (focus) {
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [
      acceptsImages,
      appendImageAttachments,
      attachmentTargetBlocked,
      insertFileReferences,
      noteAttachmentTargetBlocked,
      resolvedBatchIsCurrent,
      setNotice,
      textareaRef
    ]
  )

  const attachResolvedPaths = useCallback(
    (
      paths: string[],
      connectionId?: string | null,
      options: NativeChatResolvedPathOptions = {}
    ) => {
      if (paths.length === 0 || disabledRef.current) {
        return
      }
      if (options.destinationIsCurrent?.() === false) {
        setNotice(nativeChatAttachmentOwnerChangedNotice())
        return
      }
      const targetOwnerIsCurrent = options.targetOwnerIsCurrent?.()
      if (targetOwnerIsCurrent === false) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return
      }
      if (attachmentTargetBlocked(targetOwnerIsCurrent === true)) {
        noteAttachmentTargetBlocked()
        return
      }
      if (isComposing()) {
        const pendingCount = pendingResolvedBatchesRef.current.reduce(
          (count, batch) => count + batch.length,
          0
        )
        if (paths.length > NATIVE_FILE_DROP_MAX_PATHS - pendingCount) {
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
        pendingResolvedBatchesRef.current.push(
          paths.map((path) => ({
            path,
            connectionId,
            ...options
          }))
        )
        return
      }
      applyResolvedPaths(
        paths.map((path) => ({
          path,
          connectionId,
          ...options
        })),
        true
      )
    },
    [
      applyResolvedPaths,
      attachmentTargetBlocked,
      isComposing,
      noteAttachmentTargetBlocked,
      setNotice
    ]
  )

  const flushPendingAttachments = useCallback(() => {
    const batches = pendingResolvedBatchesRef.current
    let preserveNotice = pendingPathLimitRejectedRef.current
    pendingResolvedBatchesRef.current = []
    pendingPathLimitRejectedRef.current = false
    if (batches.length === 0 || disabledRef.current) {
      return
    }
    const paths = batches.flatMap((batch) => {
      if (resolvedBatchIsCurrent(batch)) {
        return batch
      }
      preserveNotice = true
      return []
    })
    applyResolvedPaths(paths, false, preserveNotice)
  }, [applyResolvedPaths, resolvedBatchIsCurrent])

  return { attachResolvedPaths, disabledRef, flushPendingAttachments }
}
