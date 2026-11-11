import { useCallback, useImperativeHandle, type ForwardedRef } from 'react'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { useNativeChatComposerPaste } from '../../paste/use-native-chat-composer-paste'
import type { UseNativeChatComposerPasteArgs } from '../../paste/native-chat-composer-paste-options'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatAddressPreviews } from '../../attachments/previews/use-native-chat-address-previews'
import { useNativeChatPastedTextFile } from '../../paste/use-native-chat-pasted-text-file'
import type { NativeChatComposerInput } from './native-chat-composer-input'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText'> & {
    /** Intake only: captured with the paste action, never consulted during settlement. */
    resend?: NativeChatComposerHandle['resend']
    draft: string
    addressPreviewsEnabled: boolean
    /** A structured chat's editor while it shows this scope, where a long paste saved as a file lands. */
    pastedTextEditor: (() => NativeChatComposerInput | null) | null
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
    scopeKey: args.attachmentScopeKey ?? '',
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
  const insertPastedTextOrFile = useNativeChatPastedTextFile({
    scopeKey: args.attachmentScopeKey ?? '',
    // Without a draft scope there is no draft for a pending paste to settle in.
    scopeEditor: args.attachmentScopeKey ? args.pastedTextEditor : null,
    resolveAttachmentOwner: args.resolveAttachmentOwner,
    insertTypedText: insertPreviewableText,
    setNotice: args.setNotice
  })
  const { handlePaste: handlePasteEvent, pasteFromClipboard } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPastedTextOrFile
  })

  useImperativeHandle(
    ref,
    () => ({
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
      textareaRef,
      isComposing,
      focus,
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
  return { handlePasteEvent, addressPreviews }
}
