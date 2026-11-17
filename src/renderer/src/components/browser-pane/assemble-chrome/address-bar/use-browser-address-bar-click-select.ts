import { useCallback, useRef, type MouseEvent } from 'react'

/** Match browser mouse selection: focus click selects the URL, double-click a word, triple-click the URL again. */
export function useBrowserAddressBarClickSelect(): {
  onMouseDown: (event: MouseEvent<HTMLInputElement>) => void
  onClick: (event: MouseEvent<HTMLInputElement>) => void
} {
  const pressFocusedRef = useRef(false)

  const onMouseDown = useCallback((event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    pressFocusedRef.current = event.button === 0 && document.activeElement !== input
    // Clear old selections before native word/caret placement; Chromium otherwise treats the press as a text drag.
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
