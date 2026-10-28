import { useEffect, type RefObject } from 'react'

// Why: split views mount several mirrors; only the container that reported focus may clear it.
let focusOwner: HTMLElement | null = null

/** Main resolves app shortcuts in before-input-event, before any renderer handler can yield them. */
export function useEditorKeymapFocusMirror(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!enabled || !container) {
      return
    }
    const report = (focused: boolean): void => {
      if (!focused && focusOwner !== container) {
        return
      }
      focusOwner = focused ? container : null
      window.api.ui.setEditorKeymapFocused(focused)
    }
    const onFocusIn = (): void => report(true)
    const onFocusOut = (event: FocusEvent): void => {
      // Moving into the find widget keeps editor focus.
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) {
        return
      }
      report(false)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    // Why: the preset can be switched on while the editor already holds focus.
    if (container.contains(document.activeElement)) {
      report(true)
    }
    return () => {
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      report(false)
    }
  }, [containerRef, enabled])
}
