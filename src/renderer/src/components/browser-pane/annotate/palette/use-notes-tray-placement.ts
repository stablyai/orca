import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

const TRAY_WIDTH_PX = 320
const EDGE_PX = 12
const GAP_PX = 6

/**
 * Places the notes list under the palette's "N notes" chip (above it when the palette sits low, where there's more
 * room), so it opens where it was asked for. Follows the chip when the palette moves or the page area resizes;
 * undefined (the default corner) while the list is closed.
 */
export function useNotesTrayPlacement(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean
): CSSProperties | undefined {
  const [placement, setPlacement] = useState<CSSProperties | undefined>()

  useLayoutEffect(() => {
    const container = containerRef.current
    const chip = container?.querySelector<HTMLElement>('[data-browser-annotate-notes-chip]')
    if (!open || !container || !chip) {
      return
    }
    const measure = (): void => {
      const area = container.getBoundingClientRect()
      const anchor = chip.getBoundingClientRect()
      const width = Math.min(TRAY_WIDTH_PX, area.width - EDGE_PX * 2)
      const left = Math.min(
        Math.max(EDGE_PX, anchor.left - area.left),
        area.width - width - EDGE_PX
      )
      const below = anchor.bottom - area.top + GAP_PX
      const above = area.bottom - anchor.top + GAP_PX
      const top = below <= above ? below : 'auto'
      const bottom = below <= above ? 'auto' : above
      setPlacement((current) =>
        current?.top === top &&
        current.bottom === bottom &&
        current.left === left &&
        current.width === width
          ? current
          : {
              top,
              left,
              right: 'auto',
              bottom,
              width,
              maxHeight: `calc(100% - ${(top === 'auto' ? above : below) + EDGE_PX}px)`
            }
      )
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(container)
    resize?.observe(chip)
    // The palette moves by its inline left/top (drag, find bar); follow it.
    const palette = chip.closest('[data-browser-annotate-palette]')
    const moves = palette ? new MutationObserver(measure) : null
    if (palette) {
      moves?.observe(palette, { attributes: true, attributeFilter: ['style'] })
    }
    return () => {
      resize?.disconnect()
      moves?.disconnect()
    }
  }, [containerRef, open])

  return open ? placement : undefined
}
