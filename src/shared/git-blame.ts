export type GitBlameLine = {
  sha: string
  shortSha: string
  author: string
  /** Unix timestamp in seconds */
  authorTime: number
  /** First line of the commit message */
  summary: string
}

/**
 * Index 0 corresponds to line 1 of the file.
 * Null entries mean the line is not committed (new/dirty).
 */
export type GitBlameResult = (GitBlameLine | null)[]
