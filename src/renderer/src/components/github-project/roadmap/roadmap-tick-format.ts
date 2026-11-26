import {
  type RoadmapSpan,
  type RoadmapTick,
  type RoadmapZoom,
  ROADMAP_DAY_MS
} from '../../../../../shared/github/projects/project-roadmap-timeline'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

export type RoadmapTickLabel = { label: string; sublabel: string | null }

const TICK_MONTH: Intl.DateTimeFormatOptions = { month: 'short', timeZone: 'UTC' }
const SPAN_DAY: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
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
  const month = uiDateTimeFormat(TICK_MONTH, locale).format(date)
  // Show the year at the grid’s start and each January instead of repeating it monthly.
  return { label: month, sublabel: index === 0 || date.getUTCMonth() === 0 ? year : null }
}

/** Format the inclusive calendar span GitHub displays, rather than the geometry’s exclusive end. */
export function formatRoadmapSpan(span: RoadmapSpan, locale: string): string {
  const format = uiDateTimeFormat(SPAN_DAY, locale)
  const start = format.format(new Date(span.startMs))
  if (span.point) {
    return start
  }
  return `${start} – ${format.format(new Date(span.endMs - ROADMAP_DAY_MS))}`
}
