// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'
import {
  CRASH_REPORT_ATTRIBUTION_DETAIL_KEY,
  CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY,
  UNRELIABLE_BOUNDARY_ATTRIBUTION
} from './react-update-depth-attribution'

/** Promotes the attribution caveat above the details blob so a triager cannot scroll past it. */
export function appendBoundaryAttributionLines(
  lines: string[],
  details: Record<string, CrashReportDetailValue>
): void {
  if (details[CRASH_REPORT_ATTRIBUTION_DETAIL_KEY] !== UNRELIABLE_BOUNDARY_ATTRIBUTION) {
    return
  }
  const note = details[CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY]
  lines.push('', `Attribution: ${UNRELIABLE_BOUNDARY_ATTRIBUTION}`)
  if (typeof note === 'string' && note) {
    lines.push(note)
  }
}
