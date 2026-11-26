export type GitBlameCommit = {
  oid: string
  author: string
  authorEmail: string
  /** Unix epoch milliseconds. */
  authorTime: number
  summary: string
}

/**
 * Blame of a file as committed at `headOid`. `ranges` is flat triples of
 * `[startLine (1-based), lineCount, commitIndex]`, sorted by start line.
 */
export type GitBlameResult =
  | {
      kind: 'ready'
      /** HEAD's oid, marked when the repo is shallow; echoed back as `knownHeadOid`. */
      headOid: string
      commits: GitBlameCommit[]
      ranges: number[]
      /** The HEAD blob, the baseline unsaved and uncommitted edits are mapped against. */
      headText: string
    }
  /** `unchanged`: HEAD still matches the caller's `knownHeadOid`, so nothing is resent. */
  | { kind: 'untracked' | 'too-large' | 'unavailable' | 'unchanged' }
