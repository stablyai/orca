/**
 * True when a key event comes from another browser page's pane or annotate palette. Each page's Esc owners (picker,
 * Draw, pending Draw) ignore those, so Esc in one split never leaves annotate mode in another.
 */
export function keyEventBelongsToOtherAnnotatePage(
  target: EventTarget | null,
  pageId: string
): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  const palette = target.closest('[data-browser-annotate-page]')
  if (palette) {
    return palette.getAttribute('data-browser-annotate-page') !== pageId
  }
  const pane = target.closest('[data-browser-page-pane-id]')
  return pane !== null && pane.getAttribute('data-browser-page-pane-id') !== pageId
}
