export type BrowserPageZoomDirection = 'in' | 'out' | 'reset'

export const BROWSER_PAGE_ZOOM_STEP = 0.5
export const BROWSER_PAGE_ZOOM_MIN = -3
export const BROWSER_PAGE_ZOOM_MAX = 5
export const DEFAULT_BROWSER_PAGE_ZOOM_LEVEL = 0

export const BROWSER_PAGE_ZOOM_LEVELS: readonly number[] = Array.from(
  {
    length: Math.round((BROWSER_PAGE_ZOOM_MAX - BROWSER_PAGE_ZOOM_MIN) / BROWSER_PAGE_ZOOM_STEP) + 1
  },
  (_, index) => BROWSER_PAGE_ZOOM_MIN + index * BROWSER_PAGE_ZOOM_STEP
)

export function normalizeBrowserPageZoomLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
  }
  const roundedToStep = Math.round(value / BROWSER_PAGE_ZOOM_STEP) * BROWSER_PAGE_ZOOM_STEP
  return Math.max(BROWSER_PAGE_ZOOM_MIN, Math.min(BROWSER_PAGE_ZOOM_MAX, roundedToStep))
}

export function browserPageZoomLevelToPercent(level: number): number {
  // Why: Electron zoom levels are exponential; show the same percentage users
  // expect from Chromium browser zoom controls.
  return Math.round(100 * Math.pow(1.2, normalizeBrowserPageZoomLevel(level)))
}

export function nextBrowserPageZoomLevel(
  current: number,
  direction: BrowserPageZoomDirection,
  resetLevel: number = DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
): number {
  const rawNext =
    direction === 'in'
      ? current + BROWSER_PAGE_ZOOM_STEP
      : direction === 'out'
        ? current - BROWSER_PAGE_ZOOM_STEP
        : normalizeBrowserPageZoomLevel(resetLevel)

  return normalizeBrowserPageZoomLevel(rawNext)
}
