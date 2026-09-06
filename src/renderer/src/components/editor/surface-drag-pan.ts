export type SurfacePanOrigin = {
  pointerId: number
  clientX: number
  clientY: number
  scrollLeft: number
  scrollTop: number
}

type SurfacePanPointerEventLike = {
  button: number
  pointerType: string
}

export type SurfaceScrollOffsets = {
  scrollLeft: number
  scrollTop: number
}

// Why: touch already pans through native scrolling, and claiming the pointer
// there would fight the browser's own gesture handling.
export function shouldStartSurfacePan(event: SurfacePanPointerEventLike): boolean {
  return event.button === 0 && event.pointerType !== 'touch'
}

// Why: the content follows the pointer, so scroll moves against it, and both
// offsets are measured from the press rather than the previous move so a drag
// cannot accumulate rounding drift.
export function getPannedScrollOffsets(
  origin: SurfacePanOrigin,
  clientX: number,
  clientY: number
): SurfaceScrollOffsets {
  return {
    scrollLeft: origin.scrollLeft - (clientX - origin.clientX),
    scrollTop: origin.scrollTop - (clientY - origin.clientY)
  }
}
