// Why: per-line authorship for the status-bar and inline git-blame surfaces.
// `isUncommitted` marks git's all-zero "not committed yet" sha (a local,
// unsaved/uncommitted line).
export type GitLineBlameResult = {
  sha: string
  author: string
  authorTimeMs: number
  summary: string
  isUncommitted: boolean
}
