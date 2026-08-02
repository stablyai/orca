import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { HistoryState } from './native-chat-composer-state'

/** Imperative text insertion and focus for the composer textarea, used by the
 *  paste pipeline and the composer's imperative handle. */
export function useNativeChatTypedInsertion(args: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  caret: number
  draft: string
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): { insertTypedText: (text: string) => boolean; focus: () => boolean } {
  const { textareaRef, caret, draft, setDraft, setCaret, setHistory, setActiveSuggestion } = args

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
      setHistory((prev) => ({ entries: prev.entries, index: null }))
      setActiveSuggestion(0)
      requestAnimationFrame(() => {
        textarea.setSelectionRange(nextCaret, nextCaret)
      })
      return true
    },
    [caret, draft, setActiveSuggestion, setCaret, setDraft, setHistory, textareaRef]
  )

  const focus = useCallback((): boolean => {
    const textarea = textareaRef.current
    if (!textarea || textarea.disabled) {
      return false
    }
    textarea.focus()
    return true
  }, [textareaRef])

  return { insertTypedText, focus }
}
