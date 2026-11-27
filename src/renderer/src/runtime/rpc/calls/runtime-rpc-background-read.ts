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

/** A caller's tag can add background, never remove what the params already say. */
export function isBackgroundRuntimeCall(tagged: boolean | undefined, params: unknown): boolean {
  return tagged === true || isBackgroundRuntimeRead(params)
}

/** A click or key in the last few seconds while this host owns the focused workspace: typing in
 *  another workspace must not wake an idle-stopped WSL host some background call targets. */
export function hasRecentUserGestureFor(environmentId: string): boolean {
  if (typeof navigator === 'undefined' || navigator.userActivation?.isActive !== true) {
    return false
  }
  return readFocusedHostEnvironmentId() === environmentId
}

// Injected at startup by the store's owner: importing the store here would close an import cycle.
let readFocusedHostEnvironmentId: () => string | null = () => null

export function provideFocusedHostEnvironmentId(read: () => string | null): void {
  readFocusedHostEnvironmentId = read
}
