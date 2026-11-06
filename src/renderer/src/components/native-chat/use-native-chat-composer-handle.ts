import { useCallback, useImperativeHandle, type ForwardedRef } from 'react'
import type { ClipboardEventLike } from './native-chat-clipboard-payload'
import type {
  NativeChatComposerHandle,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import {
  useNativeChatComposerPaste,
  type UseNativeChatComposerPasteArgs
} from './use-native-chat-composer-paste'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import type { NativeChatComposerInput } from './native-chat-composer-input'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText'> & {
    /** Stable pane/session identity, excluding the replaceable PTY. */
    draftTarget?: {
      paneKey: string
      transport?: Pick<
        NativeChatStructuredComposerTransport,
        'sessionId' | 'worktreeId' | 'runtimeEnvironmentId'
      >
    }
    /** Intake only: captured with the paste action, never consulted during settlement. */
    resend?: NativeChatComposerHandle['resend']
    /** A structured chat's editor while it shows this scope, where a long paste saved as a file lands. */
    pastedTextEditor: (() => NativeChatComposerInput | null) | null
  }

/** Expose typed/pasted insertion to pane routing and return the paste handler. */
export function useNativeChatComposerHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: UseNativeChatComposerHandleArgs
): (event: ClipboardEventLike) => void {
  const { textareaRef, isComposing, setDraft, setActiveSuggestion, ...pasteArgs } = args
  const { insertTypedText, appendText, acceptsText, insertPastedText, focus, contains } =
    useNativeChatTypedInsertion({
      textareaRef,
      isComposing,
      setDraft,
      setCaret: args.setCaret,
      setActiveSuggestion
    })

  const insertPastedTextOrFile = useNativeChatPastedTextFile({
    scopeKey: args.attachmentScopeKey ?? '',
    // Without a draft scope there is no draft for a pending paste to settle in.
    scopeEditor: args.attachmentScopeKey ? args.pastedTextEditor : null,
    resolveAttachmentOwner: args.resolveAttachmentOwner,
    insertTypedText: insertPastedText,
    setNotice: args.setNotice
  })
  const insertCommentText = useCallback(
    (text: string): Promise<boolean> =>
      new Promise((resolve) => {
        insertPastedTextOrFile(text, resolve)
      }),
    [insertPastedTextOrFile]
  )
  const {
    handlePaste: handlePasteEvent,
    pasteFromClipboard,
    attachCommentedImage
  } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPastedTextOrFile,
    insertCommentText
  })

  const target = args.draftTarget
  const draftKey = args.attachmentScopeKey
    ? JSON.stringify([
        args.attachmentScopeKey,
        ...(target
          ? [
              target.paneKey,
              target.transport?.sessionId,
              target.transport?.worktreeId,
              target.transport?.runtimeEnvironmentId
            ]
          : [args.targetKey])
      ])
    : undefined
  useImperativeHandle(
    ref,
    () => ({
      draftKey,
      insertAgentReferences: (references) => {
        const input = textareaRef.current
        if (!input || input.disabled || !input.insertAgentReferences || isComposing()) {
          return false
        }
        input.insertAgentReferences(references)
        input.focus()
        return true
      },
      isComposing,
      focus,
      attachCommentedImage,
      resend: args.resend,
      insertTypedText,
      insertPastedText: insertPastedTextOrFile,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains
    }),
    [
      draftKey,
      textareaRef,
      isComposing,
      focus,
      attachCommentedImage,
      args.resend,
      insertTypedText,
      insertPastedTextOrFile,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains
    ]
  )
  return handlePasteEvent
}
