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
