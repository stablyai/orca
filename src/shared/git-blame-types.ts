export type GitBlameCommit = {
  sha: string
  author: string
  authorEmail: string
  /** Epoch milliseconds (git author-time seconds × 1000). */
  authorTime: number
  summary: string
  /** Lines not yet in any commit (git reports the all-zero object id). */
  uncommitted: boolean
}

/** Consecutive final-file lines attributed to one commit; lines are 1-based. */
export type GitBlameHunk = {
  sha: string
  startLine: number
  lineCount: number
}

export type GitBlameResult = {
  commits: Record<string, GitBlameCommit>
  hunks: GitBlameHunk[]
}
