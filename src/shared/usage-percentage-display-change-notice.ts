/**
 * Resolve whether the one-time "usage now shows percent used" notice is
 * already dismissed for this profile.
 *
 * - Explicit dismissal stays dismissed.
 * - Brand-new profiles never saw percent-remaining as the default, so they
 *   should not get a change notice.
 * - Users who already chose "remaining" have found the setting; no need to
 *   teach the flip.
 * - Upgraded profiles still on the new default ("used"/missing) get the notice.
 */
export function resolveUsagePercentageDisplayChangeNoticeDismissed(args: {
  rawDismissed: unknown
  rawUsagePercentageDisplay: unknown
  isExistingProfile: boolean
}): boolean {
  if (args.rawDismissed === true) {
    return true
  }
  if (!args.isExistingProfile) {
    return true
  }
  // Why: choosing remaining is the discovery path; re-teaching the default flip
  // would only interrupt someone who already adapted.
  if (args.rawUsagePercentageDisplay === 'remaining') {
    return true
  }
  return false
}

export function shouldShowUsagePercentageDisplayChangeNotice(args: {
  persistedUIReady: boolean
  usagePercentageDisplayChangeNoticeDismissed: boolean
  statusBarVisible: boolean
  hasVisibleUsageMeters: boolean
  activeModal: string
}): boolean {
  return (
    args.persistedUIReady &&
    !args.usagePercentageDisplayChangeNoticeDismissed &&
    args.statusBarVisible &&
    args.hasVisibleUsageMeters &&
    args.activeModal === 'none'
  )
}
