import { useLayoutEffect, useState, type RefObject } from 'react'
import { PALETTE_EDGE_INSET_PX } from './use-palette-horizontal-drag'

/** Marks the toolbar button that opens the palette, so exiting can hand focus back to it. */
export const BROWSER_ANNOTATE_BUTTON_ATTRIBUTE = 'data-browser-annotate-button'

/**
 * Room kept beside the tool labels for the widest tool's controls (Draw's row, ⋯, colour, Undo, Copy markup)
 * plus grip, separators and Done. Why one budget: the labels show or hide for every tool at a given width, so
 * switching tools never changes the switch's shape.
 */
const WIDEST_TOOL_RESERVE_PX = 360

export function isEditableFocus(element: HTMLElement): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable
  )
}

export function focusAnnotateButtonNear(start: Element | null): void {
  for (let node = start?.parentElement ?? null; node; node = node.parentElement) {
    const button = node.querySelector<HTMLElement>(`[${BROWSER_ANNOTATE_BUTTON_ATTRIBUTE}]`)
    if (button) {
      button.focus()
      return
    }
  }
}

/** Tool labels show when the measured label row plus the widest tool's controls fit the page width. */
export function useToolLabelsFit(
  bounds: HTMLElement | null,
  labelProbeRef: RefObject<HTMLElement | null>
): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const probe = labelProbeRef.current
    if (!bounds || !probe) {
      return
    }
    const check = (): void => {
      const boundsWidth = bounds.clientWidth
      if (boundsWidth === 0) {
        return
      }
      setFits(boundsWidth - PALETTE_EDGE_INSET_PX * 2 >= probe.offsetWidth + WIDEST_TOOL_RESERVE_PX)
    }
    check()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(check)
    observer.observe(bounds)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [bounds, labelProbeRef])
  return fits
}
