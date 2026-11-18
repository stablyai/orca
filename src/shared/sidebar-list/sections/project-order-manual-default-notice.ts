export function resolveProjectOrderManualDefaultNoticeDismissed(args: {
  rawDismissed: unknown
  rawProjectOrderBy: unknown
  isExistingProfile: boolean
}): boolean {
  if (args.rawDismissed === true) {
    return true
  }
  if (!args.isExistingProfile) {
    return true
  }
  // Why: users who already opted into recent ordering keep it without a notice.
  if (args.rawProjectOrderBy === 'recent') {
    return true
  }
  return false
}

export function isExistingPersistedProfile(args: {
  repoCount: number
  onboardingClosedAt: number | null | undefined
  ui: unknown
}): boolean {
  return (
    args.repoCount > 0 ||
    args.onboardingClosedAt != null ||
    (args.ui != null && typeof args.ui === 'object' && Object.keys(args.ui).length > 0)
  )
}
