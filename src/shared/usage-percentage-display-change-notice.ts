/** Show the default-flip notice only to upgraded profiles still using used/missing; fresh profiles, explicit dismissals and users who chose remaining need no notice. */
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
  // Choosing remaining already demonstrates discovery; do not interrupt with the flip notice.
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
