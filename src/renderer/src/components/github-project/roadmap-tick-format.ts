// Why: tick geometry is locale-free and lives in the shared timeline module;
// only the human-readable labels need Intl, so they are formatted here.
import type {
  RoadmapSpan,
  RoadmapTick,
  RoadmapZoom
} from '../../../../shared/github/project-roadmap-timeline'
import { ROADMAP_DAY_MS } from '../../../../shared/github/project-roadmap-timeline'

export type RoadmapTickLabel = { label: string; sublabel: string | null }

// Why: Intl.DateTimeFormat construction costs ~0.1-1ms, and these run per tick
// and per bar on every render — cache per locale; the options never vary.
const monthFormatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  let formatter = cache.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    cache.set(locale, formatter)
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
  // Why: repeating the year on every month is noise — show it where the
  // reader loses the thread, at the grid's start and each January.
  return { label: month, sublabel: index === 0 || date.getUTCMonth() === 0 ? year : null }
}

/** Renders the span back as the inclusive calendar range the user typed on
 *  GitHub, so the tooltip matches the field values rather than the exclusive
 *  end the geometry uses. */
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
