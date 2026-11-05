import { useEffect, useState, type RefObject } from 'react'

// Overlay below this slot width so the toolbar’s shrinkable address bar remains editable when other controls squeeze it.
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

/** Whether the focused bar should overlay the toolbar, measured off the slot it sits in. */
export function useBrowserAddressBarOverlay(
  slotRef: RefObject<HTMLDivElement | null>,
  focused: boolean
): boolean {
  const [inlineWidth, setInlineWidth] = useState<number | null>(null)
  // Measure the stable flex slot, not the overlaying form, to avoid width oscillation.
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
  }, [slotRef])
  return shouldOverlayBrowserAddressBar({ inlineWidth, focused })
}
