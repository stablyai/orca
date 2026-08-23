/**
 * React's nested-update counter is module-global and keyed on the root, not per fiber, so
 * "Maximum update depth exceeded" (minified #185) throws on whichever fiber calls setState
 * next after the counter trips. The catching boundary is a bystander picked by commit order.
 */

export const UNRELIABLE_BOUNDARY_ATTRIBUTION = 'unreliable'
export type CrashReportAttribution = typeof UNRELIABLE_BOUNDARY_ATTRIBUTION

export const CRASH_REPORT_ATTRIBUTION_DETAIL_KEY = 'attribution'
export const CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY = 'attribution_note'

// Keep under the 240-char detail cap so the note is never truncated mid-sentence.
export const UNRELIABLE_BOUNDARY_ATTRIBUTION_NOTE =
  'React #185: the throw lands on whichever component called setState next after a root-global counter tripped, so boundary_id and component_stack name a bystander. Do not cluster these reports by boundary_id.'

// #185 only: require a non-digit after 185 so #1850+ and #18 never match.
const REACT_UPDATE_DEPTH_ERROR =
  /Minified React error #185(?!\d)|errors\/185(?!\d)|invariant=185(?!\d)|Maximum update depth exceeded/

function messageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error) {
    return error.message
  }
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string') {
    return (error as Error).message
  }
  return ''
}

export function getReactErrorBoundaryAttribution(
  error: unknown
): CrashReportAttribution | undefined {
  return REACT_UPDATE_DEPTH_ERROR.test(messageOf(error))
    ? UNRELIABLE_BOUNDARY_ATTRIBUTION
    : undefined
}
