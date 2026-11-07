import {
  insertNativeChatPastedText,
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { withQuoteAppended } from './native-chat-selection-quote-draft'
import { dictationSeparators } from '../../../../shared/dictation-transcript-spacing'

/** Insert/focus through the composer input for paste and imperative callers. */
export function useNativeChatTypedInsertion(args: {
  textareaRef: RefObject<NativeChatComposerInput | null>
  isComposing: () => boolean
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): {
  insertTypedText: (text: string, options?: { dictated?: boolean }) => boolean
  appendText: (text: string) => void
  acceptsText: () => boolean
  insertPastedText: (text: string) => boolean
  focus: () => boolean
  contains: (node: Node | null) => boolean
} {
  const { textareaRef, isComposing, setDraft, setCaret, setActiveSuggestion } = args

  const usableInput = useCallback((): NativeChatComposerInput | null => {
    const textarea = textareaRef.current
    return textarea && !textarea.disabled ? textarea : null
  }, [textareaRef])

  const showDraft = useCallback(
    (textarea: NativeChatComposerInput, next: string, nextCaret: number): void => {
      // Mark the draft dirty before the suppressed transaction saves its chip document.
      setDraft(next)
      // An IME composition owns the field; the draft reaches it once the composition settles.
      if (!isComposing()) {
        writeNativeChatComposerText(textarea, next, nextCaret)
      }
      setCaret(nextCaret)
      setActiveSuggestion(0)
    },
    [isComposing, setActiveSuggestion, setCaret, setDraft]
  )

  const insertTypedText = useCallback(
    (text: string, options?: { dictated?: boolean }): boolean => {
      const textarea = usableInput()
      if (!textarea) {
        return false
      }
      const { value } = textarea
      const selectionStart = textarea.selectionStart ?? value.length
      const selectionEnd = textarea.selectionEnd ?? selectionStart
      const before = value.slice(0, selectionStart)
      const after = value.slice(selectionEnd)
      const { leading, trailing } = options?.dictated
        ? dictationSeparators(before, text, after)
        : { leading: '', trailing: '' }
      showDraft(
        textarea,
        `${before}${leading}${text}${trailing}${after}`,
        before.length + leading.length + text.length
      )
      return true
    },
    [showDraft, usableInput]
  )

  const appendText = useCallback(
    (text: string): void => {
      const textarea = usableInput()
      if (textarea) {
        // A quote the user adds lands after what they typed, as typing it would.
        const next = withQuoteAppended({ text: textarea.value }, text).text
        showDraft(textarea, next, next.length)
      }
    },
    [showDraft, usableInput]
  )

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
