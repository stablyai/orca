/**
 * Reads whose own params already say nobody asked for them: a background admission tier (git
 * status safety ticks, interval branch compares, unselected review reads) or a timer's
 * stale-while-revalidate read the user did not refresh (PR and checks polls). They are no use of an
 * idle WSL host and never wake one Orca stopped idle (#46567).
 */
export function isBackgroundRuntimeRead(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) {
    return false
  }
  if ('admissionTier' in params && params.admissionTier === 'background') {
    return true
  }
  return (
    'reason' in params &&
    params.reason === 'swr' &&
    !('userRefresh' in params && params.userRefresh === true)
  )
}

/** The window's transient user activation (a click or key in the last few seconds). */
export function hasRecentUserGesture(): boolean {
  return typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true
}
