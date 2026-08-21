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
