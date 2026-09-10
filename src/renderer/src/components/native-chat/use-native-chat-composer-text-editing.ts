// Text-editing handlers for the composer textarea: caret sync, draft edits, IME
// composition, and mention acceptance. These share one concern — keeping draft,
// caret, history, and the picker's trigger state consistent on every edit — so
// they live together rather than inline in NativeChatComposer.

import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import {
  applyMentionSuggestion,
  type ComposerAutocomplete,
  type HistoryState
} from './native-chat-composer-state'

export type NativeChatComposerTextEditing = {
  handleDraftChange: (value: string, element: HTMLTextAreaElement) => void
  handleTextareaSelect: (element: HTMLTextAreaElement) => void
  handleCompositionStart: () => void
  handleCompositionEnd: (element: HTMLTextAreaElement) => void
  acceptMention: () => void
  /** Read by the keydown hook so Enter never submits mid-IME-composition. */
  isComposing: () => boolean
}

export function useNativeChatComposerTextEditing(args: {
  draft: string
  caret: number
  autocomplete: ComposerAutocomplete
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  handleDraftOrCaretChange: (value: string, caret: number) => void
}): NativeChatComposerTextEditing {
  const {
    draft,
    caret,
    autocomplete,
    textareaRef,
    setDraft,
    setCaret,
    setHistory,
    setActiveSuggestion,
    handleDraftOrCaretChange
  } = args
  const isComposingRef = useRef(false)

  const syncCaret = useCallback(
    (element: HTMLTextAreaElement) => {
      setCaret(element.selectionStart ?? element.value.length)
    },
    [setCaret]
  )

  const handleDraftChange = useCallback(
    (value: string, element: HTMLTextAreaElement) => {
      setDraft(value)
      setHistory((prev) => ({ entries: prev.entries, index: null }))
      syncCaret(element)
      handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
      setActiveSuggestion(0)
    },
    [handleDraftOrCaretChange, setActiveSuggestion, setDraft, setHistory, syncCaret]
  )

  const handleTextareaSelect = useCallback(
    (element: HTMLTextAreaElement) => {
      syncCaret(element)
      handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
      setActiveSuggestion(0)
    },
    [handleDraftOrCaretChange, setActiveSuggestion, syncCaret]
  )

  const handleCompositionEnd = useCallback(
    (element: HTMLTextAreaElement) => {
      isComposingRef.current = false
      // Why: some IMEs commit without firing input, so reconcile the draft here.
      if (element.value !== draft) {
        handleDraftChange(element.value, element)
      }
    },
    [draft, handleDraftChange]
  )

  const acceptMention = useCallback(() => {
    if (autocomplete.mode !== 'mention') {
      return
    }
    const result = applyMentionSuggestion(draft, caret, autocomplete.query)
    setDraft(result.draft)
    setCaret(result.caret)
    const textarea = textareaRef.current
    textarea?.focus()
    requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
  }, [autocomplete, caret, draft, setCaret, setDraft, textareaRef])

  return {
    handleDraftChange,
    handleTextareaSelect,
    handleCompositionStart: useCallback(() => {
      isComposingRef.current = true
    }, []),
    handleCompositionEnd,
    acceptMention,
    isComposing: useCallback(() => isComposingRef.current, [])
  }
}
