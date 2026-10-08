import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { appendReturnedDraftText } from '../../../../shared/returned-draft-text'

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
  appendText: (text: string) => void
  acceptsText: () => boolean
  insertPastedText: (text: string) => boolean
  focus: () => boolean
  contains: (node: Node | null) => boolean
} {
  const { textareaRef, caret, draft, setDraft, setCaret, setActiveSuggestion } = args

  const usableInput = useCallback((): NativeChatComposerInput | null => {
    const textarea = textareaRef.current
    return textarea && !textarea.disabled ? textarea : null
  }, [textareaRef])

  const showDraft = useCallback(
    (textarea: NativeChatComposerInput, next: string, nextCaret: number): void => {
      textarea.focus()
      setDraft(next)
      setCaret(nextCaret)
      setActiveSuggestion(0)
      requestAnimationFrame(() => {
        textarea.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [setActiveSuggestion, setCaret, setDraft]
  )

  const insertTypedText = useCallback(
    (text: string): boolean => {
      const textarea = usableInput()
      if (!textarea) {
        return false
      }
      const selectionStart = textarea.selectionStart ?? caret
      const selectionEnd = textarea.selectionEnd ?? selectionStart
      showDraft(
        textarea,
        `${draft.slice(0, selectionStart)}${text}${draft.slice(selectionEnd)}`,
        selectionStart + text.length
      )
      return true
    },
    [caret, draft, showDraft, usableInput]
  )

  const appendText = useCallback(
    (text: string): void => {
      const textarea = usableInput()
      if (textarea) {
        const next = appendReturnedDraftText(draft, text)
        showDraft(textarea, next, next.length)
      }
    },
    [draft, showDraft, usableInput]
  )

  // Reads the live input when a delayed clipboard read settles.
  const insertPastedText = useCallback(
    (text: string): boolean => insertNativeChatPastedText(textareaRef.current, text),
    [textareaRef]
  )

  const acceptsText = useCallback((): boolean => usableInput() !== null, [usableInput])

  const focus = useCallback((): boolean => {
    const textarea = usableInput()
    textarea?.focus()
    return textarea !== null
  }, [usableInput])

  const contains = useCallback(
    (node: Node | null): boolean => textareaRef.current?.contains?.(node) === true,
    [textareaRef]
  )

  return { insertTypedText, appendText, acceptsText, insertPastedText, focus, contains }
}
