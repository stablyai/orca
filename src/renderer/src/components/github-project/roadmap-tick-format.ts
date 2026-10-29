import type {
  RoadmapSpan,
  RoadmapTick,
  RoadmapZoom
} from '../../../../shared/github/project-roadmap-timeline'
import { ROADMAP_DAY_MS } from '../../../../shared/github/project-roadmap-timeline'

export type RoadmapTickLabel = { label: string; sublabel: string | null }

// Cache formatters per locale because ticks and bars reuse fixed options on every render.
const monthFormatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const MAX_FORMATTER_LOCALES = 32

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  let formatter = cache.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    cache.set(locale, formatter)
    while (cache.size > MAX_FORMATTER_LOCALES) {
      const oldest = cache.keys().next()
      if (oldest.done) {
        break
      }
      cache.delete(oldest.value)
    }
  }
  return formatter
}

export function formatRoadmapTick(
  tick: RoadmapTick,
  zoom: RoadmapZoom,
  index: number,
  locale: string
): RoadmapTickLabel {
  const date = new Date(tick.startMs)
  const year = String(date.getUTCFullYear())
  if (zoom === 'year') {
    return { label: year, sublabel: null }
  }
  if (zoom === 'quarter') {
    return { label: `Q${Math.floor(date.getUTCMonth() / 3) + 1}`, sublabel: year }
  }
  const month = cachedFormatter(monthFormatters, locale, {
    month: 'short',
    timeZone: 'UTC'
  }).format(date)
  // Show the year at the grid’s start and each January instead of repeating it monthly.
  return { label: month, sublabel: index === 0 || date.getUTCMonth() === 0 ? year : null }
}

/** Format the inclusive calendar span GitHub displays, rather than the geometry’s exclusive end. */
export function formatRoadmapSpan(span: RoadmapSpan, locale: string): string {
  const format = cachedFormatter(dayFormatters, locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
  const start = format.format(new Date(span.startMs))
  if (span.point) {
    return start
  }
  return `${start} – ${format.format(new Date(span.endMs - ROADMAP_DAY_MS))}`
}
