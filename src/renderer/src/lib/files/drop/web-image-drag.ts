// A browser drags a page's image as its HTML and link, never as a file; dragged text also carries text/plain.
export function hasWebImageDragTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  const values = Array.from(types ?? [])
  return values.includes('text/html') && !values.includes('Files') && !values.includes('text/plain')
}

/** The dragged image's own source: inline data or HTTPS; null when the HTML names no image. */
export function droppedWebImageUrl(html: string): string | null {
  const src = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('img[src]')
    ?.getAttribute('src')
    ?.trim()
  return src && /^(data:image\/|https:)/i.test(src) ? src : null
}
