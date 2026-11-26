/** Git-ignored files `git worktree remove` would delete that exist nowhere else (.env, local config). */
export type WorktreeAtRiskLocalFiles = {
  /** Ignored files or whole ignored directories holding content the main checkout lacks. */
  count: number
  /** A few notable worktree-relative paths, `.env*` first; directories end in `/`. */
  samplePaths: string[]
  /** Sorted at-risk worktree-relative paths (up to path cap); absent on older hosts or compact summaries. */
  paths?: string[]
  /** False when a time or size cap or a failure cut the check short, so more files may be at risk. */
  complete: boolean
}

export function hasWorktreeAtRiskLocalFiles(files: WorktreeAtRiskLocalFiles): boolean {
  return files.count > 0 || !files.complete
}
