import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'

export function useNativeChatPromptSuggestion({
  scopeKey,
  enabled,
  draft,
  suggestion,
  readTerminalSuggestion,
  inputRef,
  insertTypedText
}: {
  scopeKey: string
  enabled: boolean
  draft: string
  suggestion?: string | null
  readTerminalSuggestion?: () => string | null
  inputRef: RefObject<NativeChatComposerInput | null>
  insertTypedText: (text: string) => boolean
}): { promptSuggestion: string | null; accept: () => boolean; dismiss: () => boolean } {
  const [terminal, setTerminal] = useState<{ scope: string; text: string | null } | null>(null)
  useEffect(() => {
    if (!enabled || !readTerminalSuggestion) {
      setTerminal(null)
      return
    }
    const read = (): void => {
      const text = readTerminalSuggestion()
      setTerminal((previous) =>
        previous?.scope === scopeKey && previous.text === text
          ? previous
          : { scope: scopeKey, text }
      )
    }
    read()
    const timer = setInterval(read, 500)
    return () => clearInterval(timer)
  }, [enabled, readTerminalSuggestion, scopeKey])
  const candidate = suggestion ?? (terminal?.scope === scopeKey ? terminal.text : null)
  const [seen, setSeen] = useState({ scope: scopeKey, text: candidate, dismissed: draft !== '' })
  if (seen.scope !== scopeKey || seen.text !== candidate || (!seen.dismissed && draft !== '')) {
    setSeen({ scope: scopeKey, text: candidate, dismissed: draft !== '' })
  }
  const promptSuggestion =
    enabled &&
    draft === '' &&
    candidate &&
    !(seen.scope === scopeKey && seen.text === candidate && seen.dismissed)
      ? candidate
      : null
  const dismiss = useCallback(() => {
    if (!promptSuggestion) {
      return false
    }
    setSeen({ scope: scopeKey, text: promptSuggestion, dismissed: true })
    return true
  }, [promptSuggestion, scopeKey])
  const accept = useCallback(() => {
    if (!promptSuggestion || inputRef.current?.value !== '') {
      return false
    }
    // The terminal may have changed since the last poll; never accept an obsolete screen.
    if (readTerminalSuggestion && readTerminalSuggestion() !== promptSuggestion) {
      return false
    }
    if (!insertTypedText(promptSuggestion)) {
      return false
    }
    dismiss()
    return true
  }, [dismiss, inputRef, insertTypedText, promptSuggestion, readTerminalSuggestion])
  return { promptSuggestion, accept, dismiss }
}
