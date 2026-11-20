import { useLayoutEffect, useState, type RefObject } from 'react'
import { PALETTE_EDGE_INSET_PX } from './use-palette-horizontal-drag'

/** Marks the toolbar button that opens the palette, so exiting can hand focus back to it. */
export const BROWSER_ANNOTATE_BUTTON_ATTRIBUTE = 'data-browser-annotate-button'

/**
 * Room kept beside the tool labels for the widest tool's controls (Draw's row, ⋯, colour, Undo, Copy markup)
 * plus grip, separators and Done. Why one budget: the labels show or hide for every tool at a given width, so
 * switching tools never changes the switch's shape.
 */
const COMPACT_DRAW_RESERVE_PX = 360
const FULL_DRAW_RESERVE_PX = 480

export function widestPaletteWidth(bounds: HTMLElement, labelProbe: HTMLElement): number {
  return Math.min(
    bounds.clientWidth - PALETTE_EDGE_INSET_PX * 2,
    labelProbe.offsetWidth + FULL_DRAW_RESERVE_PX
  )
}

export function isEditableFocus(element: HTMLElement): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable
  )
}

/**
 * After Esc closes the notes list: focus returns to the "N notes" chip, unless the user was typing (the comment card's
 * field), which keeps its focus so typing can go on.
 */
export function returnFocusAfterNotesClose(container: HTMLElement | null): void {
  const focused = document.activeElement
  if (focused instanceof HTMLElement && isEditableFocus(focused)) {
    return
  }
  container
    ?.querySelector<HTMLElement>('[data-browser-annotate-notes-chip]')
    ?.focus({ preventScroll: true })
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
      setFits(
        boundsWidth - PALETTE_EDGE_INSET_PX * 2 >= probe.offsetWidth + COMPACT_DRAW_RESERVE_PX
      )
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
