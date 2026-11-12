export type PRCommentsDisplayMode = 'triage' | 'timeline'

/** Optional: readers treat a missing value as Grouped with no filter, matching older clients. */
export type PRCommentsListSettings = {
  /** Preferred PR comments layout in the Checks panel. Per-user, not per-workspace. */
  prCommentsDisplayMode?: PRCommentsDisplayMode
  /** Hide resolved review threads in the Checks panel comments. Per-user, not per-workspace. */
  prCommentsHideResolved?: boolean
}
