/** Absolute child offsets use local CSS pixels, while pointer events and bounding rects use viewport pixels. */
export function clientPointInElement(
  element: HTMLElement,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
  rect = element.getBoundingClientRect()
): { x: number; y: number } {
  const zoom = element.currentCSSZoom || 1
  return { x: (point.clientX - rect.left) / zoom, y: (point.clientY - rect.top) / zoom }
}
