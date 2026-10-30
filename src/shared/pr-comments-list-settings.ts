export type PRCommentsDisplayMode = 'triage' | 'timeline'

export type PRCommentsListSettings = {
  /** Preferred PR comments layout in the Checks panel. Per-user, not per-workspace. */
  prCommentsDisplayMode: PRCommentsDisplayMode
  /** Hide resolved review threads in the Checks panel comments. Per-user, not per-workspace. */
  prCommentsHideResolved: boolean
}
