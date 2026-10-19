import { useCallback, useRef, type MouseEvent } from 'react'

/**
 * Browser-style mouse selection for the address bar: the click that focuses it selects the whole
 * URL, a double-click selects a word, and a triple-click selects everything again.
 */
export function useBrowserAddressBarClickSelect(): {
  onMouseDown: (event: MouseEvent<HTMLInputElement>) => void
  onClick: (event: MouseEvent<HTMLInputElement>) => void
} {
  const pressFocusedRef = useRef(false)

  const onMouseDown = useCallback((event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    pressFocusedRef.current = event.button === 0 && document.activeElement !== input
    // Why: Chromium treats a press inside a selection as a text drag, so it neither places a caret
    // nor picks a double-click word; clear the old or click-made selection first.
    if (pressFocusedRef.current) {
      // Focus first: a press that focuses the bar would restore the selection being cleared.
      input.focus()
      input.setSelectionRange(0, 0)
    } else if (event.detail === 2) {
      input.setSelectionRange(0, 0)
    }
  }, [])

  const onClick = useCallback((event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    // Preserve native drag selection; only expand a collapsed focusing click.
    if (pressFocusedRef.current && input.selectionStart === input.selectionEnd) {
      input.select()
    }
    pressFocusedRef.current = false
  }, [])

  return { onMouseDown, onClick }
}
