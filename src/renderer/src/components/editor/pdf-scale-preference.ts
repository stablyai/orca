import { getPinchZoomFactor } from './image-viewer-zoom'

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

export function getNextPdfWheelScale(
  currentScale: number,
  deltaY: number,
  deltaMode: number,
  bounds: { min: number; max: number }
): number {
  return clampPdfScale(currentScale * getPinchZoomFactor(deltaY, deltaMode), bounds.min, bounds.max)
}

export function applyPdfWheelScale(
  viewer: {
    currentScale: number
    updateScale: (options: { scaleFactor: number; origin: [number, number] }) => void
  },
  event: { clientX: number; clientY: number; deltaMode: number; deltaY: number },
  bounds: { min: number; max: number }
): number {
  const currentScale = viewer.currentScale
  const nextScale = getNextPdfWheelScale(currentScale, event.deltaY, event.deltaMode, bounds)
  if (nextScale !== currentScale) {
    // Why: pdf.js's getter masks its zero-valued unknown scale, so seed it before multiplication.
    viewer.currentScale = currentScale
    viewer.updateScale({
      scaleFactor: nextScale / currentScale,
      origin: [event.clientX, event.clientY]
    })
  }
  return viewer.currentScale
}

export function shouldHandlePdfZoomWheel(
  event: { ctrlKey: boolean; metaKey: boolean },
  platform: NodeJS.Platform
): boolean {
  return event.ctrlKey || (platform === 'darwin' && event.metaKey)
}
