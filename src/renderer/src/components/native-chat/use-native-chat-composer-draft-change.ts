import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { HistoryState } from './native-chat-composer-state'

export type NativeChatComposerDraftChange = {
  /** `onChange` for the composer textarea. */
  handleDraftChange: (value: string, element: HTMLTextAreaElement) => void
  /** `onSelect` for the composer textarea. */
  handleCaretChange: (element: HTMLTextAreaElement) => void
  /** `onCompositionEnd` for the composer textarea; clears the composing flag. */
  handleCompositionEnd: (element: HTMLTextAreaElement) => void
}

/**
 * Splits the composer's per-keystroke work into the half that must run on every
 * input event and the half that only has to be right once a character is
 * committed.
 *
 * Why: a Hangul IME emits one input event per jamo, so a three-jamo syllable
 * runs this path three times for one visible character (and any CJK IME does the
 * same over a longer preedit). The draft and caret have to stay in sync on every
 * one of them — the textarea is controlled, so a stale `draft` would be written
 * back over the live preedit — but the derived state (picker derivation, history
 * index reset, suggestion reset) is only meaningful for committed text.
 */
export function useNativeChatComposerDraftChange(args: {
  draft: string
  isComposingRef: { current: boolean }
  setDraft: (value: string) => void
  syncCaret: (element: HTMLTextAreaElement) => void
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  handleDraftOrCaretChange: (value: string, caret: number) => void
}): NativeChatComposerDraftChange {
  const {
    draft,
    isComposingRef,
    setDraft,
    syncCaret,
    setHistory,
    setActiveSuggestion,
    handleDraftOrCaretChange
  } = args

  const applyDerived = useCallback(
    (value: string, caret: number) => {
      setHistory((prev) => ({ entries: prev.entries, index: null }))
      handleDraftOrCaretChange(value, caret)
      setActiveSuggestion(0)
    },
    [handleDraftOrCaretChange, setActiveSuggestion, setHistory]
  )

  const handleDraftChange = useCallback(
    (value: string, element: HTMLTextAreaElement) => {
      setDraft(value)
      syncCaret(element)
      if (isComposingRef.current) {
        return
      }
      applyDerived(value, element.selectionStart ?? value.length)
    },
    [applyDerived, isComposingRef, setDraft, syncCaret]
  )

  const handleCaretChange = useCallback(
    (element: HTMLTextAreaElement) => {
      syncCaret(element)
      // The IME moves the selection on every preedit keystroke; the picker only
      // needs the caret the user actually committed to.
      if (isComposingRef.current) {
        return
      }
      applyDerived(element.value, element.selectionStart ?? element.value.length)
    },
    [applyDerived, isComposingRef, syncCaret]
  )

  const handleCompositionEnd = useCallback(
    (element: HTMLTextAreaElement) => {
      isComposingRef.current = false
      const committed = element.value
      if (committed !== draft) {
        handleDraftChange(committed, element)
        return
      }
      // The composing keystrokes already adopted this value, so re-adopting it
      // would be a duplicate write. Only the derived work they deferred is still
      // owed — without it the picker keeps looking at pre-composition text.
      applyDerived(committed, element.selectionStart ?? committed.length)
    },
    [applyDerived, draft, handleDraftChange, isComposingRef]
  )

  return { handleDraftChange, handleCaretChange, handleCompositionEnd }
}
