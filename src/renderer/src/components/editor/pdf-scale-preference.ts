import { getPinchZoomFactor, shouldHandleImageZoomWheel } from './image-viewer-zoom'

export type PdfScalePreference = 'page-width' | number

export function clampPdfScale(scale: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scale))
}

/** Apply a stored zoom preference after pdf.js loads a (re)document. */
export function applyPdfScalePreference(
  viewer: { currentScale: number; currentScaleValue: string },
  preference: PdfScalePreference,
  bounds: { min: number; max: number }
): void {
  if (typeof preference === 'number') {
    viewer.currentScale = clampPdfScale(preference, bounds.min, bounds.max)
    return
  }
  viewer.currentScaleValue = 'page-width'
}

/** Zoom in/out while recording the resulting absolute scale preference. */
export function stepPdfScalePreference(
  currentScale: number,
  direction: 'in' | 'out',
  bounds: { min: number; max: number; step: number }
): { scale: number; preference: number } {
  const next =
    direction === 'in'
      ? clampPdfScale(currentScale * bounds.step, bounds.min, bounds.max)
      : clampPdfScale(currentScale / bounds.step, bounds.min, bounds.max)
  return { scale: next, preference: next }
}

type PdfWheelZoomEvent = Pick<
  WheelEvent,
  'ctrlKey' | 'deltaY' | 'deltaMode' | 'clientX' | 'clientY' | 'preventDefault'
>

/** Ctrl-wheel / trackpad-pinch zoom that keeps the content under the pointer in place. */
export function zoomPdfViewerWithWheel(
  viewer: {
    currentScale: number
    container: {
      scrollLeft: number
      scrollTop: number
      getBoundingClientRect: () => { left: number; top: number }
    }
    update: () => void
  },
  event: PdfWheelZoomEvent,
  bounds: { min: number; max: number }
): number | null {
  if (!shouldHandleImageZoomWheel(event)) {
    return null
  }
  event.preventDefault()
  const previous = viewer.currentScale
  const next = clampPdfScale(
    previous * getPinchZoomFactor(event.deltaY, event.deltaMode),
    bounds.min,
    bounds.max
  )
  if (next === previous) {
    return null
  }
  const { container } = viewer
  const rect = container.getBoundingClientRect()
  // Why: an absolute scale avoids updateScale's 0.01 rounding, which swallows slow pinches.
  viewer.currentScale = next
  // Why: pdf.js keeps the viewport's top-left fixed, so shift by the pointer's grown offset.
  const growth = next / previous - 1
  container.scrollLeft += (event.clientX - rect.left) * growth
  container.scrollTop += (event.clientY - rect.top) * growth
  // Why: pdf.js re-reads its location on the next frame; a faster pinch event would anchor to the old one.
  viewer.update()
  return next
}
