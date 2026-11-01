import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import { nativeChatAttachmentOwnerChangedNotice } from './native-chat-attachment-upload'
import {
  nativeChatWorkspaceAttachmentMismatchNotice,
  type NativeChatResolvedPathOperation,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'

type ResolvedAttachmentPath = {
  path: string
  connectionId?: string | null
} & Omit<NativeChatResolvedPathOptions, 'operation'>

type ResolvedAttachmentBatch = {
  paths: ResolvedAttachmentPath[]
  operation?: NativeChatResolvedPathOperation
}

type Args = {
  /** False when the agent takes no image input: an image is then referenced by path like any file. */
  acceptsImages?: boolean
  appendImageAttachments: (paths: { path: string; connectionId?: string | null }[]) => void
  attachmentTargetBlocked: (targetOwned?: boolean) => boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  mountedRef: RefObject<boolean>
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
  mountedRef,
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
  const pendingResolvedBatchesRef = useRef<ResolvedAttachmentBatch[]>([])
  const pendingPathLimitRejectedRef = useRef(false)
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      const batches = pendingResolvedBatchesRef.current
      pendingResolvedBatchesRef.current = []
      batches.forEach(({ operation }) => operation?.cancel())
      pendingPathLimitRejectedRef.current = false
    }
  }, [disabled])

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      const input = textareaRef.current
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
    (resolvedPaths: ResolvedAttachmentPath[], quiet = false): boolean => {
      if (resolvedPaths.some(({ destinationIsCurrent }) => destinationIsCurrent?.() === false)) {
        if (!quiet) {
          setNotice(nativeChatAttachmentOwnerChangedNotice())
        }
        return false
      }
      if (resolvedPaths.some(({ targetOwnerIsCurrent }) => targetOwnerIsCurrent?.() === false)) {
        if (!quiet) {
          setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        }
        return false
      }
      return true
    },
    [setNotice]
  )

  const applyResolvedPaths = useCallback(
    (
      batches: ResolvedAttachmentBatch[],
      focus: boolean,
      preserveNotice = false,
      intoScope = false
    ) => {
      try {
        const current = batches.filter(({ paths }) => {
          if (resolvedBatchIsCurrent(paths, intoScope)) {
            return true
          }
          preserveNotice = true
          return false
        })
        const paths = current.flatMap((batch) => batch.paths)
        const ownedBlocked =
          paths.some(({ targetOwnerIsCurrent }) => targetOwnerIsCurrent) &&
          attachmentTargetBlocked(true)
        const clientLocalBlocked =
          paths.some(({ targetOwnerIsCurrent }) => !targetOwnerIsCurrent) &&
          attachmentTargetBlocked(false)
        const filePaths: string[] = []
        let attached = false
        for (const batch of current) {
          const attachable = batch.paths.filter(({ targetOwnerIsCurrent }) =>
            targetOwnerIsCurrent ? !ownedBlocked : !clientLocalBlocked
          )
          if (attachable.length === 0) {
            continue
          }
          if (batch.operation) {
            attached =
              batch.operation.apply(intoScope ? null : (paths) => filePaths.push(...paths)) ||
              attached
          } else {
            const images = attachable.filter(
              ({ path }) => acceptsImages && isNativeChatImageAttachmentPath(path)
            )
            appendImageAttachments(images.map(({ path, connectionId }) => ({ path, connectionId })))
            filePaths.push(
              ...attachable.filter((path) => !images.includes(path)).map(({ path }) => path)
            )
            attached = true
          }
        }
        insertFileReferences(filePaths)
        if (!intoScope) {
          if (ownedBlocked || clientLocalBlocked) {
            noteAttachmentTargetBlocked()
          } else if (attached && !preserveNotice) {
            setNotice(null)
          }
          if (attached && focus) {
            requestAnimationFrame(() => textareaRef.current?.focus())
          }
        }
      } finally {
        batches.forEach(({ operation }) => operation?.cancel())
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
  const applyRef = useRef(applyResolvedPaths)
  useLayoutEffect(() => {
    applyRef.current = applyResolvedPaths
  }, [applyResolvedPaths])
  useEffect(
    () => () => {
      const batches = pendingResolvedBatchesRef.current
      pendingResolvedBatchesRef.current = []
      if (disabledRef.current) {
        batches.forEach(({ operation }) => operation?.cancel())
      } else {
        applyRef.current(
          batches.filter(({ operation }) => operation),
          false,
          true,
          true
        )
      }
    },
    [mountedRef]
  )

  const attachResolvedPaths = useCallback(
    (
      paths: string[],
      connectionId?: string | null,
      options: NativeChatResolvedPathOptions = {}
    ) => {
      const { operation: suppliedOperation, ...pathOptions } = options
      let operation = suppliedOperation
      try {
        if (paths.length === 0 || disabledRef.current) {
          return
        }
        if (
          !resolvedBatchIsCurrent(
            paths.map((path) => ({ path, ...pathOptions })),
            !mountedRef.current
          )
        ) {
          return
        }
        if (attachmentTargetBlocked(options.targetOwnerIsCurrent?.() === true)) {
          if (mountedRef.current) {
            noteAttachmentTargetBlocked()
          }
          return
        }
        if (isComposing() && (mountedRef.current || !operation)) {
          const pendingCount = pendingResolvedBatchesRef.current.reduce(
            (count, batch) => count + batch.paths.length,
            0
          )
          if (paths.length > NATIVE_FILE_DROP_MAX_PATHS - pendingCount) {
            pendingPathLimitRejectedRef.current = true
            setNotice(
              translate(
                'components.native-chat.composer.pendingAttachmentLimit',
                'Too many attachments are waiting. Finish composing before attaching more.'
              )
            )
            return
          }
          pendingResolvedBatchesRef.current.push({
            paths: paths.map((path) => ({ path, connectionId, ...pathOptions })),
            operation
          })
          operation = undefined
          return
        }
        const batch = {
          paths: paths.map((path) => ({ path, connectionId, ...pathOptions })),
          operation
        }
        operation = undefined
        applyResolvedPaths([batch], options.focus !== false, false, !mountedRef.current)
      } finally {
        operation?.cancel()
      }
    },
    [
      applyResolvedPaths,
      attachmentTargetBlocked,
      isComposing,
      mountedRef,
      noteAttachmentTargetBlocked,
      resolvedBatchIsCurrent,
      setNotice
    ]
  )

  const flushPendingAttachments = useCallback(() => {
    const batches = pendingResolvedBatchesRef.current
    const preserveNotice = pendingPathLimitRejectedRef.current
    pendingResolvedBatchesRef.current = []
    pendingPathLimitRejectedRef.current = false
    if (disabledRef.current) {
      batches.forEach(({ operation }) => operation?.cancel())
      return
    }
    applyResolvedPaths(batches, false, preserveNotice)
  }, [applyResolvedPaths])

  return { attachResolvedPaths, disabledRef, flushPendingAttachments }
}
