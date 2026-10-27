// Reuse chat intake with edit-owned images so paste cannot modify the chat draft.

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type RefObject
} from 'react'
import { toast } from 'sonner'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import {
  NativeChatPasteRequest,
  NATIVE_CHAT_PASTE_REQUEST_EVENT
} from '@/lib/native-chat-paste-request'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import type { ClipboardEventLike } from './native-chat-clipboard-payload'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { registerNestedWorkspaceDropSink } from './native-chat-pane-file-drop'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'

/** The queued edit’s owning chat and attachment transport. */
export type QueuedEditAttachTarget = {
  terminalTabId: string
  transport: Pick<
    NativeChatStructuredComposerTransport,
    'acceptsImages' | 'worktreeId' | 'sessionId' | 'runtimeEnvironmentId'
  >
}

const noop = (): void => {}

export function useNativeChatQueuedEditImageIntake(
  editor: QueuedMessageInlineEditor,
  attachTo: QueuedEditAttachTarget | undefined,
  field: RefObject<HTMLTextAreaElement | null>
): {
  /** The host can replace images and the agent can read them, enabling Attach/paste/drop. */
  editable: boolean
  attach: () => void
  /** On the whole card, so a paste with focus on its buttons lands in the edit too. */
  onPasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void
  hostEnvironmentId: string | undefined
  isDragActive: boolean
} {
  const intake = editor.images?.intake
  const transport = attachTo?.transport
  const editable = Boolean(intake && transport && transport.acceptsImages !== false)
  const { change, saving, acquiring } = editor
  // Require the edit lease and freeze intake while Save sends its image snapshot.
  const busy = saving || acquiring
  const [isDragActive, setIsDragActive] = useState(false)
  const liveIntake = useRef(intake)
  useLayoutEffect(() => {
    liveIntake.current = intake
  }, [intake])
  const setNotice = useCallback((notice: string | null) => {
    if (notice) {
      toast.error(notice)
    }
  }, [])
  // Insert at this edit’s caret; never modify a replacement edit.
  const insertText = useCallback(
    (insertion: string): boolean => {
      const input = field.current
      if (!input || busy || liveIntake.current !== intake) {
        return false
      }
      input.setRangeText(insertion, input.selectionStart, input.selectionEnd, 'end')
      change(input.value)
      return true
    },
    [busy, change, field, intake]
  )
  const insertReferences = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) {
        insertText(`${paths.map(formatNativeChatFileReference).join(' ')} `)
      }
    },
    [insertText]
  )
  const pendingChips = useMemo(
    (): NativeChatPendingAttachmentChips => ({
      begin: (previewUrl, pendingName) => intake?.begin(previewUrl, pendingName) ?? null,
      resolve: (id, path, connectionId) => intake?.resolve(id, path, connectionId) ?? false,
      drop: (id) => intake?.drop(id) ?? false,
      attachReferences: (references) => {
        const kept = references.filter(({ id }) => intake?.drop(id))
        insertReferences(kept.map(({ path }) => path))
        return kept.length > 0
      }
    }),
    [insertReferences, intake]
  )
  const attachResolvedPaths = useCallback(
    (
      paths: string[],
      connectionId?: string | null,
      options: NativeChatResolvedPathOptions = {}
    ) => {
      const { operation } = options
      try {
        const current =
          options.destinationIsCurrent?.() !== false && options.targetOwnerIsCurrent?.() !== false
        if (!intake || !current || busy) {
          return
        }
        if (operation) {
          operation.apply(insertReferences)
        } else {
          insertReferences(intake.append(paths, connectionId))
        }
      } finally {
        operation?.cancel()
      }
    },
    [busy, insertReferences, intake]
  )
  const disabled = !editable || busy
  const external = useNativeChatExternalAttachments({
    terminalTabId: attachTo?.terminalTabId ?? '',
    structuredWorktreeId: transport?.worktreeId,
    structuredSession: transport
      ? { sessionId: transport.sessionId, runtimeEnvironmentId: transport.runtimeEnvironmentId }
      : undefined,
    disabled,
    attachResolvedPaths,
    pendingChips,
    setNotice
  })
  const { captureReservedAttachments, captureExternalDrop } = external
  const captureCopiedFiles = useCallback(
    (options?: { focus?: boolean }) => captureReservedAttachments(undefined, options),
    [captureReservedAttachments]
  )
  const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
    targetKey: editor.messageId,
    disabled,
    caret: 0,
    resolveAttachmentOwner: external.resolveAttachmentOwner,
    attachResolvedPaths,
    attachCopiedFiles: external.attachExternalPaths,
    captureCopiedFiles,
    beginPendingImageAttachment: pendingChips.begin,
    resolvePendingImageAttachment: pendingChips.resolve,
    revealPendingImageAttachment: intake?.reveal,
    dropPendingImageAttachment: pendingChips.drop,
    insertTypedText: insertText,
    setCaret: noop,
    setNotice
  })
  const onPasteCapture = useCallback(
    (event: ClipboardEventLike & { target: EventTarget | null }) => {
      if (
        editable &&
        (Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === 'file') ||
          (document.activeElement === field.current && (busy || event.target !== field.current)))
      ) {
        handlePaste(event)
        event.preventDefault()
      }
    },
    [busy, editable, field, handlePaste]
  )
  const ownerRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const attachOwner = useOsFileDropOwner(ownerRef, {
    consumer: (destination) => destination?.preparationConsumer ?? 'agent',
    // Paired-host chats upload bytes; other owners refuse with a notice.
    acceptsBrowserFiles: true,
    sequence,
    canAccept: () => !disabled,
    captureDestination: () => captureExternalDrop(),
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await destination?.(prepared.paths)
    }
  })
  useLayoutEffect(() => {
    const card = field.current?.closest('[data-queued-message-editor]')
    const owner = editable && card instanceof HTMLElement ? card : null
    attachOwner(owner)
    const paste = (event: Event): void => {
      if (event instanceof NativeChatPasteRequest) {
        event.preventDefault()
        if (event.clipboardEvent) {
          onPasteCapture(event.clipboardEvent)
        } else {
          pasteFromClipboard()
        }
      }
    }
    const input = owner ? field.current : null
    input?.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, paste)
    // Internal tree drags arrive here after the chat’s workspace claim checks them.
    const hover = (active: boolean): void => setIsDragActive(active && !disabled)
    const unregister = owner
      ? registerNestedWorkspaceDropSink(owner, attachResolvedPaths, hover)
      : null
    const clear = (): void => setIsDragActive(false)
    clear()
    document.addEventListener('drop', clear, true)
    document.addEventListener('dragend', clear, true)
    return () => {
      attachOwner(null)
      input?.removeEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, paste)
      unregister?.()
      document.removeEventListener('drop', clear, true)
      document.removeEventListener('dragend', clear, true)
    }
  }, [
    attachOwner,
    attachResolvedPaths,
    disabled,
    editable,
    field,
    onPasteCapture,
    pasteFromClipboard
  ])
  const { pickAttachments } = useNativeChatFileAttachmentActions(external.attachExternalPaths)
  return {
    editable,
    attach: pickAttachments,
    onPasteCapture,
    isDragActive: isDragActive && !disabled,
    hostEnvironmentId: transport?.runtimeEnvironmentId ?? undefined
  }
}
