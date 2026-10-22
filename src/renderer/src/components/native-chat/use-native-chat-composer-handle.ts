import { useCallback, useImperativeHandle, type ForwardedRef } from 'react'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  useNativeChatComposerPaste,
  type UseNativeChatComposerPasteArgs
} from './use-native-chat-composer-paste'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatAddressPreviews } from './use-native-chat-address-previews'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText'> & {
    draft: string
    addressPreviewsEnabled: boolean
  }

/** Typed and pasted insertion and its address previews share the composer lifetime. */
export function useNativeChatComposerHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: UseNativeChatComposerHandleArgs
) {
  const {
    textareaRef,
    draft,
    isComposing,
    setDraft,
    setActiveSuggestion,
    addressPreviewsEnabled,
    ...pasteArgs
  } = args
  const addressPreviews = useNativeChatAddressPreviews({
    scopeKey: JSON.stringify([args.attachmentScopeKey, args.targetKey]),
    draft,
    inputRef: textareaRef,
    enabled: addressPreviewsEnabled
  })
  const { onTextPasted } = addressPreviews
  const { insertTypedText, appendText, acceptsText, insertPastedText, focus, contains } =
    useNativeChatTypedInsertion({
      textareaRef,
      isComposing,
      setDraft,
      setCaret: args.setCaret,
      setActiveSuggestion
    })

  const insertPreviewableText = useCallback(
    (text: string): boolean => {
      if (!insertPastedText(text)) {
        return false
      }
      onTextPasted(text)
      return true
    },
    [insertPastedText, onTextPasted]
  )
  const { handlePaste: handlePasteEvent, pasteFromClipboard } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPreviewableText
  })

  useImperativeHandle(
    ref,
    () => ({
      focus,
      insertTypedText,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains
    }),
    [
      focus,
      insertTypedText,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains
    ]
  )
  return { handlePasteEvent, addressPreviews }
}
