/**
 * True when a key event comes from another browser page's pane or annotate palette. Each page's Esc owners (picker,
 * Draw, pending Draw) ignore those, so Esc in one split never leaves annotate mode in another.
 */
export function keyEventBelongsToOtherAnnotatePage(
  target: EventTarget | null,
  pageId: string
): boolean {
  if (!(target instanceof Element)) {
    return document.querySelectorAll('[data-browser-annotate-page]').length > 1
  }
  const palette = target.closest('[data-browser-annotate-page]')
  if (palette) {
    return palette.getAttribute('data-browser-annotate-page') !== pageId
  }
  const pane = target.closest('[data-browser-page-pane-id]')
  if (pane) {
    return pane.getAttribute('data-browser-page-pane-id') !== pageId
  }
  // Body, portals and other unmarked targets: only the one page with an open palette owns them; with several
  // open (splits), none does, so a stray Esc never closes the wrong page's mode.
  const openPalettes = Array.from(document.querySelectorAll('[data-browser-annotate-page]'))
  return openPalettes.some(
    (element) => element.getAttribute('data-browser-annotate-page') !== pageId
  )
}
