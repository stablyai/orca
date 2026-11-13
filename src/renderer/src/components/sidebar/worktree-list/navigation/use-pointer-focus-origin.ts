import { useEffect } from 'react'
import type React from 'react'

// Why: Chromium starts matching :focus-visible on a mouse-focused element after any key press,
// so the list ring must key off how focus arrived, not :focus-visible alone.
const LIST_POINTER_FOCUS_ATTRIBUTE = 'data-pointer-focus'

export function useListPointerFocusOrigin(scrollRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const list = scrollRef.current
      if (list && event.target instanceof Node && list.contains(event.target)) {
        list.setAttribute(LIST_POINTER_FOCUS_ATTRIBUTE, '')
      }
    }
    const handleFocusOut = (event: FocusEvent) => {
      const list = scrollRef.current
      // Window blur also fires focusout; focus returning to the app is not a new keyboard entry.
      if (list && event.target === list && document.hasFocus()) {
        list.removeAttribute(LIST_POINTER_FOCUS_ATTRIBUTE)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('focusout', handleFocusOut, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('focusout', handleFocusOut, { capture: true })
    }
  }, [scrollRef])
}
