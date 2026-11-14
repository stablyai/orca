import { getPinchZoomFactor, shouldHandleImageZoomWheel } from './image-viewer-zoom'

export type PdfScalePreference = 'page-width' | number

export function clampPdfScale(scale: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scale))
}

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

// Half a percent; a scale this close to fit-width already is fit-width.
const FIT_STOP_MARGIN = 0.005

/** A zoom that would pass over fit-width stops on it; the next one leaves it. */
function stopAtPdfFitScale(previous: number, next: number, fitScale: number | null): number {
  if (fitScale === null) {
    return next
  }
  const before = previous / fitScale - 1
  const after = next / fitScale - 1
  const crosses =
    (before < -FIT_STOP_MARGIN && after > -FIT_STOP_MARGIN) ||
    (before > FIT_STOP_MARGIN && after < FIT_STOP_MARGIN)
  return crosses ? fitScale : next
}

type PdfWheelZoomEvent = Pick<
  WheelEvent,
  'ctrlKey' | 'deltaY' | 'deltaMode' | 'clientX' | 'clientY' | 'preventDefault'
>

/** Ctrl-wheel / trackpad-pinch zoom that keeps the content under the pointer in place. */
export function zoomPdfViewerWithWheel(
  viewer: {
    currentScale: number
    currentScaleValue: string
    container: {
      scrollLeft: number
      scrollTop: number
      getBoundingClientRect: () => { left: number; top: number }
    }
    update: () => void
  },
  event: PdfWheelZoomEvent,
  bounds: { min: number; max: number },
  getFitScale: () => number | null
): PdfScalePreference | null {
  if (!shouldHandleImageZoomWheel(event)) {
    return null
  }
  event.preventDefault()
  const previous = viewer.currentScale
  const fitScale = getFitScale()
  const next = stopAtPdfFitScale(
    previous,
    clampPdfScale(
      previous * getPinchZoomFactor(event.deltaY, event.deltaMode),
      bounds.min,
      bounds.max
    ),
    fitScale
  )
  if (next === previous) {
    return null
  }
  const { container } = viewer
  const rect = container.getBoundingClientRect()
  const fitted = next === fitScale
  if (fitted) {
    // Why: the preset is what resizes refit to; a numeric set first could move pdf.js to a page of another width.
    viewer.currentScaleValue = 'page-width'
  } else {
    // Why: an absolute scale avoids updateScale's 0.01 rounding, which swallows slow pinches.
    viewer.currentScale = next
  }
  // Why: pdf.js keeps the viewport's top-left fixed, so shift by the pointer's grown offset.
  const growth = next / previous - 1
  container.scrollLeft += (event.clientX - rect.left) * growth
  container.scrollTop += (event.clientY - rect.top) * growth
  // Why: pdf.js re-reads its location on the next frame; a faster pinch event would anchor to the old one.
  viewer.update()
  return fitted ? 'page-width' : next
}
