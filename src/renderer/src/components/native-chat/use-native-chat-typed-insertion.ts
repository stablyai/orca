import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { applyMentionSuggestion, type HistoryState } from './native-chat-composer-state'

/** Imperative text insertion and focus for the composer textarea, used by the
 *  paste pipeline and the composer's imperative handle. */
export function useNativeChatTypedInsertion(args: {
  textareaRef: RefObject<NativeChatComposerInput | null>
  caret: number
  draft: string
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  onDraftOrCaretChange: (value: string, caret: number) => void
}): {
  insertTypedText: (text: string) => boolean
  focus: () => boolean
  handleDraftChange: (value: string, input: NativeChatComposerInput) => void
  handleSelect: (input: NativeChatComposerInput) => void
  acceptMention: (query: string) => void
} {
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

  const handleSelect = (input: NativeChatComposerInput): void => {
    const position = input.selectionStart ?? input.value.length
    setCaret(position)
    args.onDraftOrCaretChange(input.value, position)
    setActiveSuggestion(0)
  }
  const handleDraftChange = (value: string, input: NativeChatComposerInput): void => {
    setDraft(value)
    setHistory((previous) => ({ entries: previous.entries, index: null }))
    handleSelect(input)
  }
  const acceptMention = (query: string): void => {
    const result = applyMentionSuggestion(draft, caret, query)
    setDraft(result.draft)
    setCaret(result.caret)
    const input = textareaRef.current
    input?.focus()
    requestAnimationFrame(() => input?.setSelectionRange(result.caret, result.caret))
  }
  return { insertTypedText, focus, handleDraftChange, handleSelect, acceptMention }
}
