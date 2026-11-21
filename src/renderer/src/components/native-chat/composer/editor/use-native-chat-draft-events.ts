import { useCallback } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'

export function useNativeChatDraftEvents({
  setDraft,
  setCaret,
  setActiveSuggestion,
  handleDraftOrCaretChange,
  flushDraftAppends,
  flushPendingAttachments,
  draft
}: {
  draft: string
  setDraft: (text: string) => void
  setCaret: (caret: number) => void
  setActiveSuggestion: (index: number) => void
  handleDraftOrCaretChange: (text: string, caret: number) => void
  flushDraftAppends: () => void
  flushPendingAttachments: () => void
}) {
  const onDraftChange = useCallback(
    (value: string, element: NativeChatComposerInput) => {
      const caret = element.selectionStart ?? value.length
      setDraft(value)
      setCaret(caret)
      handleDraftOrCaretChange(value, caret)
      setActiveSuggestion(0)
    },
    [setDraft, setCaret, handleDraftOrCaretChange, setActiveSuggestion]
  )
  return {
    onDraftChange,
    onTextareaSelect: (element: NativeChatComposerInput) => {
      const caret = element.selectionStart ?? element.value.length
      setCaret(caret)
      handleDraftOrCaretChange(element.value, caret)
      setActiveSuggestion(0)
    },
    onImeSettled: (element: NativeChatComposerInput) => {
      if (element.value !== draft) {
        onDraftChange(element.value, element)
      }
      flushDraftAppends()
      flushPendingAttachments()
    }
  }
}
