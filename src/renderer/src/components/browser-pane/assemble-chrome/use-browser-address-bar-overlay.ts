import { useEffect, useRef, useState, type RefObject } from 'react'
import { shouldOverlayBrowserAddressBar } from './browser-address-bar-expansion'

/** Whether the focused bar overlays the toolbar, measured from the slot it sits in. */
export function useBrowserAddressBarOverlay(focused: boolean): {
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

  return { slotRef, overlay: shouldOverlayBrowserAddressBar({ inlineWidth, focused }) }
}
