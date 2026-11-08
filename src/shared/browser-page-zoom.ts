export type BrowserPageZoomDirection = 'in' | 'out' | 'reset'

export function isBrowserPageZoomDirection(value: unknown): value is BrowserPageZoomDirection {
  return value === 'in' || value === 'out' || value === 'reset'
}

export type BrowserPageZoomCommand = {
  browserPageId: string
  direction: BrowserPageZoomDirection
}

export const DEFAULT_BROWSER_PAGE_ZOOM_LEVEL = 0

// Why: Chrome's page zoom presets; Electron levels are log base 1.2 of the zoom factor.
const BROWSER_PAGE_ZOOM_PERCENTS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
] as const

export const BROWSER_PAGE_ZOOM_LEVELS: readonly number[] = BROWSER_PAGE_ZOOM_PERCENTS.map(
  (percent) => Math.log(percent / 100) / Math.log(1.2)
)

/** The nearest preset; anything that is not a finite level counts as 100%. */
function nearestZoomLevelIndex(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return BROWSER_PAGE_ZOOM_PERCENTS.indexOf(100)
  }
  let nearest = 0
  for (let index = 1; index < BROWSER_PAGE_ZOOM_LEVELS.length; index++) {
    if (
      Math.abs(BROWSER_PAGE_ZOOM_LEVELS[index] - level) <
      Math.abs(BROWSER_PAGE_ZOOM_LEVELS[nearest] - level)
    ) {
      nearest = index
    }
  }
  return nearest
}

/** Snaps any level, including ones saved before the presets, to the nearest preset. */
export function normalizeBrowserPageZoomLevel(value: unknown): number {
  return BROWSER_PAGE_ZOOM_LEVELS[nearestZoomLevelIndex(value)]
}

/** Scale Chromium applies to the guest's CSS px at this zoom level, unsnapped: UI zoom can set any level. */
export function browserPageZoomLevelToFactor(level: number): number {
  return Number.isFinite(level) ? 1.2 ** level : 1
}

export function browserPageZoomLevelToPercent(level: number): number {
  return BROWSER_PAGE_ZOOM_PERCENTS[nearestZoomLevelIndex(level)]
}

export function nextBrowserPageZoomLevel(
  current: number,
  direction: BrowserPageZoomDirection,
  resetLevel: number = DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
): number {
  if (direction === 'reset') {
    return normalizeBrowserPageZoomLevel(resetLevel)
  }
  const index = nearestZoomLevelIndex(current)
  const next = direction === 'in' ? index + 1 : index - 1
  return BROWSER_PAGE_ZOOM_LEVELS[Math.max(0, Math.min(BROWSER_PAGE_ZOOM_LEVELS.length - 1, next))]
}

// One percent in zoom-level units; closer than this, fit-width and a preset look the same.
const FIT_STOP_MARGIN = Math.log(1.01) / Math.log(1.2)

/** Zoom steps stop at fit-width when they would pass over it, and leave it for the next preset. */
export function nextBrowserPageZoomWithFitStop(
  current: { zoomLevel: number; fitWidth: boolean },
  direction: Exclude<BrowserPageZoomDirection, 'reset'>,
  fitLevel: number | null
): { zoomLevel: number; fitWidth: boolean } {
  const sign = direction === 'in' ? 1 : -1
  if (fitLevel === null) {
    return { zoomLevel: nextBrowserPageZoomLevel(current.zoomLevel, direction), fitWidth: false }
  }
  if (current.fitWidth) {
    const past = BROWSER_PAGE_ZOOM_LEVELS.filter(
      (level) => (level - fitLevel) * sign > FIT_STOP_MARGIN
    )
    const zoomLevel = direction === 'in' ? past[0] : past.at(-1)
    return zoomLevel === undefined ? current : { zoomLevel, fitWidth: false }
  }
  const from = normalizeBrowserPageZoomLevel(current.zoomLevel)
  const next = nextBrowserPageZoomLevel(from, direction)
  if ((fitLevel - from) * sign > FIT_STOP_MARGIN && (next - fitLevel) * sign > FIT_STOP_MARGIN) {
    return { zoomLevel: current.zoomLevel, fitWidth: true }
  }
  return { zoomLevel: next, fitWidth: false }
}
