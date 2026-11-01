import { useCallback } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'

export function useNativeChatComposerEditorEvents(
  readSetupHeld: () => boolean,
  setDraft: (value: string) => void,
  setCaret: (caret: number) => void,
  handleDraftOrCaretChange: (value: string, caret: number) => void,
  setActiveSuggestion: (index: number) => void
) {
  const handleDraftChange = useCallback(
    (value: string, element: NativeChatComposerInput) => {
      if (readSetupHeld()) {
        return
      }
      const nextCaret = element.selectionStart ?? value.length
      setDraft(value)
      setCaret(nextCaret)
      handleDraftOrCaretChange(value, nextCaret)
      setActiveSuggestion(0)
    },
    [handleDraftOrCaretChange, readSetupHeld, setDraft, setCaret, setActiveSuggestion]
  )

  const handleTextareaSelect = (element: NativeChatComposerInput): void => {
    const value = element.value
    const nextCaret = element.selectionStart ?? value.length
    setCaret(nextCaret)
    handleDraftOrCaretChange(value, nextCaret)
    setActiveSuggestion(0)
  }
  return { handleDraftChange, handleTextareaSelect }
}
