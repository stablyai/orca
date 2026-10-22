import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MutableRefObject,
  type RefObject,
  type SyntheticEvent
} from 'react'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

/**
 * Chrome-style inline autocomplete: typing the start of a visited address fills in the rest,
 * selected, so Enter goes there and the next keystroke simply replaces it.
 */
export function useBrowserAddressBarInlineCompletion({
  inputRef,
  value,
  buildSuggestions,
  prePreviewValueRef
}: {
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  buildSuggestions: (query: string, inline: true | string | null) => BrowserAddressBarSuggestion[]
  /** Holds the typed text while a completion shows; cleared once the completion is accepted. */
  prePreviewValueRef: MutableRefObject<string | null>
}): {
  /** The bar text while an inline completion shows. */
  inlineText: string | null
  /** The bar text for this edit when it completes inline; null keeps what was typed. */
  completeTyping: (event: ChangeEvent<HTMLInputElement>, typed: string) => string | null
  clearInline: () => void
  /** Shows `text` with the part past `typed` selected, as arrowing back to its row does. */
  showInline: (typed: string, text: string) => void
  /** Moving the caret off the completion (ArrowRight, End, a click) accepts it as typed text. */
  acceptOnCaretMove: (event: SyntheticEvent<HTMLInputElement>) => void
} {
  // Why an object: the next keystroke often completes to the same text, and a fresh object still
  // re-renders so the selection below is put back after React restores the input's value.
  const [inline, setInline] = useState<{ text: string } | null>(null)
  const inlineText = inline?.text ?? null
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)

  useLayoutEffect(() => {
    const range = pendingSelectionRef.current
    const input = inputRef.current
    if (!range || !input || input.value !== inline?.text) {
      return
    }
    pendingSelectionRef.current = null
    input.setSelectionRange(range.start, range.end)
  }, [inline, inputRef, value])

  const showInline = useCallback((typed: string, text: string): void => {
    pendingSelectionRef.current = { start: typed.length, end: text.length }
    setInline({ text })
  }, [])

  const completeTyping = useCallback(
    (event: ChangeEvent<HTMLInputElement>, typed: string): string | null => {
      const text = isTypingAtEnd(event, typed)
        ? (buildSuggestions(typed, true)[0]?.inlineText ?? null)
        : null
      const completed = text !== null && text.length > typed.length ? text : null
      if (completed === null) {
        setInline(null)
      } else {
        showInline(typed, completed)
      }
      return completed
    },
    [buildSuggestions, showInline]
  )

  const clearInline = useCallback(() => setInline(null), [])

  const acceptOnCaretMove = useCallback(
    (event: SyntheticEvent<HTMLInputElement>): void => {
      const input = event.currentTarget
      const typed = prePreviewValueRef.current
      if (
        inlineText === null ||
        typed === null ||
        input.value !== inlineText ||
        (input.selectionStart === typed.length && input.selectionEnd === inlineText.length)
      ) {
        return
      }
      // Why: otherwise a later blur or Escape would put the bar back to the typed prefix.
      prePreviewValueRef.current = null
      setInline(null)
    },
    [inlineText, prePreviewValueRef]
  )

  return { inlineText, completeTyping, clearInline, showInline, acceptOnCaretMove }
}

// Why typing only: like Chrome, a paste, an IME composition or a deletion never completes,
// so Backspace removes the completion instead of bringing it straight back.
function isTypingAtEnd(event: ChangeEvent<HTMLInputElement>, typed: string): boolean {
  const native = event.nativeEvent
  return (
    native instanceof InputEvent &&
    native.inputType === 'insertText' &&
    event.target.selectionStart === typed.length
  )
}
