import { useEffect, useRef, useState, type RefObject } from 'react'

// Every other browser toolbar control is shrink-0, so the address bar absorbs
// all of the squeeze when the pane narrows and ends up as the leading globe
// icon with a zero-width input. Below this slot width the bar overlays the
// toolbar while focused instead, keeping the URL editable (issue #11090).
export const BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH = 220

export function isBrowserAddressBarCollapsed(inlineWidth: number | null): boolean {
  return inlineWidth !== null && inlineWidth < BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH
}

export function shouldOverlayBrowserAddressBar({
  inlineWidth,
  focused
}: {
  inlineWidth: number | null
  focused: boolean
}): boolean {
  return focused && isBrowserAddressBarCollapsed(inlineWidth)
}

export function useBrowserAddressBarExpansion(focused: boolean): {
  slotRef: RefObject<HTMLDivElement | null>
  overlay: boolean
} {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [inlineWidth, setInlineWidth] = useState<number | null>(null)

  // Why: the slot keeps its flex width even while the bar overlays the toolbar,
  // so measuring it here (not the form) cannot oscillate with the overlay.
  useEffect(() => {
    const slot = slotRef.current
    if (!slot || typeof ResizeObserver === 'undefined') {
      return
    }
    const syncWidth = (): void => setInlineWidth(slot.getBoundingClientRect().width)
    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    observer.observe(slot)
    return () => observer.disconnect()
  }, [])

  const overlay = shouldOverlayBrowserAddressBar({ inlineWidth, focused })
  return { slotRef, overlay }
}
