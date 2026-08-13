import { useCallback, type RefObject } from 'react'
import { applyMentionSuggestion, type ComposerAutocomplete } from './native-chat-composer-state'

/** Accepts the active `@file` mention suggestion, replacing its query with the
 *  chosen path and moving the caret past it. */
export function useNativeChatAcceptMention(args: {
  autocomplete: ComposerAutocomplete
  draft: string
  caret: number
  setDraft: (draft: string) => void
  setCaret: (caret: number) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}): () => void {
  const { autocomplete, draft, caret, setDraft, setCaret, textareaRef } = args
  return useCallback(() => {
    if (autocomplete.mode !== 'mention') {
      return
    }
    const result = applyMentionSuggestion(draft, caret, autocomplete.query)
    setDraft(result.draft)
    setCaret(result.caret)
    const textarea = textareaRef.current
    textarea?.focus()
    requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
  }, [autocomplete, draft, caret, setDraft, setCaret, textareaRef])
}
