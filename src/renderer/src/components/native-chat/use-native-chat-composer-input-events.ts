import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'

export function useNativeChatComposerInputEvents({
  setDraft,
  setCaret,
  setActiveSuggestion,
  onDraftOrCaretChange
}: {
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  onDraftOrCaretChange: (value: string, caret: number) => void
}) {
  const onSelect = useCallback(
    (element: NativeChatComposerInput) => {
      const caret = element.selectionStart ?? element.value.length
      setCaret(caret)
      onDraftOrCaretChange(element.value, caret)
      setActiveSuggestion(0)
    },
    [setCaret, setActiveSuggestion, onDraftOrCaretChange]
  )
  const onChange = useCallback(
    (value: string, element: NativeChatComposerInput) => {
      setDraft(value)
      onSelect(element)
    },
    [onSelect, setDraft]
  )
  return { onChange, onSelect }
}
