import { useCallback, useImperativeHandle, type ForwardedRef } from 'react'
import type { ClipboardEventLike } from './native-chat-clipboard-payload'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  useNativeChatComposerPaste,
  type UseNativeChatComposerPasteArgs
} from './use-native-chat-composer-paste'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  nativeChatInlinePasteNotice,
  nativeChatInlinePasteProblem
} from './native-chat-inline-paste-limits'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText'> & {
    /** Intake only: captured with the paste action, never consulted during settlement. */
    pastesInline: () => boolean
    /** The chat editor while it shows this scope, where a long paste saved as a file lands. */
    pastedTextEditor: (() => NativeChatComposerInput | null) | null
  }

/** Expose typed/pasted insertion to pane routing and return the paste handler. */
export function useNativeChatComposerHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: UseNativeChatComposerHandleArgs
): (event: ClipboardEventLike) => void {
  const { textareaRef, isComposing, setDraft, setActiveSuggestion, ...pasteArgs } = args
  const { setNotice } = pasteArgs
  const {
    insertTypedText,
    appendText: appendTextUnbounded,
    acceptsText,
    insertPastedText,
    focus,
    contains
  } = useNativeChatTypedInsertion({
    textareaRef,
    isComposing,
    setDraft,
    setCaret: args.setCaret,
    setActiveSuggestion
  })

  // Quoting a transcript selection builds the same editor document as a paste, so it takes the same bound.
  const appendText = useCallback(
    (text: string): void => {
      const problem = nativeChatInlinePasteProblem(text)
      if (problem) {
        setNotice(nativeChatInlinePasteNotice(problem))
        return
      }
      appendTextUnbounded(text)
    },
    [appendTextUnbounded, setNotice]
  )

  const insertPastedTextOrFile = useNativeChatPastedTextFile({
    pastesInline: args.pastesInline,
    scopeKey: args.attachmentScopeKey ?? '',
    // Without a draft scope there is no draft for a pending paste to settle in.
    editor: args.pastedTextEditor ?? (() => textareaRef.current),
    filePastes: Boolean(args.attachmentScopeKey && args.pastedTextEditor),
    resolveAttachmentOwner: args.resolveAttachmentOwner,
    insertTypedText: insertPastedText,
    setNotice: args.setNotice
  })
  const { handlePaste: handlePasteEvent, pasteFromClipboard } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPastedTextOrFile
  })

  useImperativeHandle(
    ref,
    () => ({
      isComposing,
      focus,
      insertTypedText,
      insertPastedText: insertPastedTextOrFile,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains
    }),
    [
      isComposing,
      focus,
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
