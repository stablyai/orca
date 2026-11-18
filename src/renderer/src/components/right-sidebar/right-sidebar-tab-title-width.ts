import type { MeasureTabTitle } from './activity-bar/activity-bar-overflow'

let context: OffscreenCanvasRenderingContext2D | null | undefined
let settledFont: string | null = null

/** The labeled tab's title font (text-xs, font-medium); kept once web fonts have loaded. */
function tabTitleFont(): string {
  if (settledFont) {
    return settledFont
  }
  const font = `500 12px ${getComputedStyle(document.body).fontFamily}`
  if (document.fonts?.status === 'loaded') {
    settledFont = font
  }
  return font
}

/** A labeled tab's title as drawn, so the strip shows every title exactly while they fit. */
export const measureTabTitle: MeasureTabTitle = (title) => {
  if (context === undefined) {
    context =
      typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  }
  if (!context) {
    return null
  }
  context.font = tabTitleFont()
  return Math.ceil(context.measureText(title).width)
}
