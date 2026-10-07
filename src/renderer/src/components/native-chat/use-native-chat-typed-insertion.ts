import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'

/** Imperative text insertion and focus for the composer textarea, used by the
 *  paste pipeline and the composer's imperative handle. */
export function useNativeChatTypedInsertion(args: {
  textareaRef: RefObject<NativeChatComposerInput | null>
  caret: number
  draft: string
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): {
  insertTypedText: (text: string) => boolean
  insertPastedText: (text: string) => boolean
  focus: () => boolean
  contains: (node: Node | null) => boolean
} {
  const { textareaRef, caret, draft, setDraft, setCaret, setActiveSuggestion } = args

  const insertTypedText = useCallback(
    (text: string): boolean => {
      const textarea = textareaRef.current
      if (!textarea || textarea.disabled) {
        return false
      }
      const selectionStart = textarea.selectionStart ?? caret
      const selectionEnd = textarea.selectionEnd ?? selectionStart
      const next = `${draft.slice(0, selectionStart)}${text}${draft.slice(selectionEnd)}`
      const nextCaret = selectionStart + text.length
      textarea.focus()
      setDraft(next)
      setCaret(nextCaret)
      setActiveSuggestion(0)
      requestAnimationFrame(() => {
        textarea.setSelectionRange(nextCaret, nextCaret)
      })
      return true
    },
    [caret, draft, setActiveSuggestion, setCaret, setDraft, textareaRef]
  )

  // Reads the live input when a delayed clipboard read settles.
  const insertPastedText = useCallback(
    (text: string): boolean => insertNativeChatPastedText(textareaRef.current, text),
    [textareaRef]
  )

  const focus = useCallback((): boolean => {
    const textarea = textareaRef.current
    if (!textarea || textarea.disabled) {
      return false
    }
    textarea.focus()
    return true
  }, [textareaRef])

  const contains = useCallback(
    (node: Node | null): boolean => textareaRef.current?.contains?.(node) === true,
    [textareaRef]
  )

  return { insertTypedText, insertPastedText, focus, contains }
}
