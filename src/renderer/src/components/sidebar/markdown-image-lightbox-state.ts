// Why: markdown image lightboxes portal above Sheets. Sheet/Dialog dismiss
// handlers (Escape, outside pointer) must no-op while a lightbox is open so
// closing the preview does not also close the issue drawer.

let openCount = 0

export function isMarkdownImageLightboxOpen(): boolean {
  return openCount > 0
}

export function beginMarkdownImageLightbox(): () => void {
  openCount += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    openCount = Math.max(0, openCount - 1)
  }
}
