import { useImperativeHandle, type ForwardedRef } from 'react'
import type { ClipboardEventLike } from './native-chat-clipboard-payload'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  useNativeChatComposerPaste,
  type UseNativeChatComposerPasteArgs
} from './use-native-chat-composer-paste'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText'>

/** Typed and pasted insertion for the composer, exposed on the handle the chat
 *  root uses to route keystrokes and pastes into it. Returns the paste handler. */
export function useNativeChatComposerHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: UseNativeChatComposerHandleArgs
): (event: ClipboardEventLike) => void {
  const { textareaRef, draft, setDraft, setActiveSuggestion, ...pasteArgs } = args
  const { insertTypedText, insertPastedText, focus, contains } = useNativeChatTypedInsertion({
    textareaRef,
    caret: args.caret,
    draft,
    setDraft,
    setCaret: args.setCaret,
    setActiveSuggestion
  })

  const { handlePaste: handlePasteEvent, pasteFromClipboard } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPastedText
  })

  useImperativeHandle(
    ref,
    () => ({ focus, insertTypedText, handlePasteEvent, pasteFromClipboard, contains }),
    [focus, insertTypedText, handlePasteEvent, pasteFromClipboard, contains]
  )
  return handlePasteEvent
}
