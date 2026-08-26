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
  return Math.round(100 * 1.2 ** normalizeBrowserPageZoomLevel(level))
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

export type BrowserPageZoomTarget = {
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  isDestroyed?: () => boolean
}

export function applyBrowserPageZoomLevel(
  target: BrowserPageZoomTarget | null | undefined,
  level: number
): number | null {
  try {
    if (!target || target.isDestroyed?.()) {
      return null
    }
    const next = normalizeBrowserPageZoomLevel(level)
    // Why compare first: Chromium's HostZoomMap is keyed by host per partition,
    // so a no-op write still overwrites the host-wide zoom a sibling tab on the
    // same hostname set. Only write when this target actually needs to move.
    if (normalizeBrowserPageZoomLevel(target.getZoomLevel()) === next) {
      return next
    }
    target.setZoomLevel(next)
    return next
  } catch {
    return null
  }
}
