export type GitHistoryGraphColorId =
  | 'git-graph-ref'
  | 'git-graph-remote-ref'
  | 'git-graph-base-ref'
  | 'git-graph-lane-1'
  | 'git-graph-lane-2'
  | 'git-graph-lane-3'
  | 'git-graph-lane-4'
  | 'git-graph-lane-5'

export const GIT_HISTORY_REF_COLOR: GitHistoryGraphColorId = 'git-graph-ref'
export const GIT_HISTORY_REMOTE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-remote-ref'
export const GIT_HISTORY_BASE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-base-ref'

export const GIT_HISTORY_LANE_COLORS: readonly GitHistoryGraphColorId[] = [
  'git-graph-lane-1',
  'git-graph-lane-2',
  'git-graph-lane-3',
  'git-graph-lane-4',
  'git-graph-lane-5'
]

export const GIT_HISTORY_DEFAULT_LIMIT = 50
export const GIT_HISTORY_MAX_LIMIT = 200

export type GitHistoryRefCategory = 'branches' | 'remote branches' | 'tags' | 'commits'

export type GitHistoryItemRef = {
  id: string
  name: string
  revision?: string
  category?: GitHistoryRefCategory
  description?: string
  color?: GitHistoryGraphColorId
}

export type GitHistoryItemStatistics = {
  files: number
  insertions: number
  deletions: number
}

export type GitHistoryItem = {
  id: string
  parentIds: string[]
  subject: string
  message: string
  displayId?: string
  author?: string
  authorEmail?: string
  timestamp?: number
  statistics?: GitHistoryItemStatistics
  references?: GitHistoryItemRef[]
}

/**
 * Resume point for the next page, produced by the read that served the previous one.
 *
 * `anchor` pins the walk to the commit the first page was taken from, so later pages stay a
 * continuation of that same walk when HEAD moves mid-paging. `loaded` is how many commits of it
 * are already on screen.
 *
 * An offset into a pinned walk is the only resume git supports on a DAG. A single commit id
 * cannot serve as the cursor: restarting the walk at the oldest commit on screen reaches only
 * that commit's ancestors, so every parallel line of history that `--topo-order` sorted after it
 * is dropped and paging ends early with no sign anything is missing.
 */
export type GitHistoryCursor = {
  anchor: string
  loaded: number
  // The last row the previous page emitted. The next page re-reads that one row and continues only
  // if the walk still produces exactly it — same commit and same parents.
  //
  // Both halves are load-bearing. An anchor resolving does not prove its ancestry is unchanged, and
  // an id matching does not either: replace refs and grafts rewrite a commit's parents in place, so
  // the seam can keep its id while everything below it becomes a different chain. Checking the
  // parents too is what stops two walks being spliced into one list under a row whose drawn edge
  // points at a commit the list no longer contains.
  after: GitHistorySeam
}

export type GitHistorySeam = {
  id: string
  parentIds: string[]
}

export type GitHistoryOptions = {
  limit?: number
  baseRef?: string | null
  cursor?: GitHistoryCursor
}

export type GitHistoryResult = {
  items: GitHistoryItem[]
  currentRef?: GitHistoryItemRef
  remoteRef?: GitHistoryItemRef
  baseRef?: GitHistoryItemRef
  mergeBase?: string
  hasIncomingChanges: boolean
  hasOutgoingChanges: boolean
  hasMore: boolean
  limit: number
  // Whether this page continued the cursor the request carried. A cursor is not honored when its
  // anchor no longer resolves (rebase, amend, prune, gc) or when the walk under it drifted, and in
  // both cases the page is a fresh first page that must replace what is on screen rather than
  // extend it. Absent — and so never a continuation — from hosts too old to page.
  continuedCursor?: boolean
  // Cursor to send for the next page, present only when one exists. Carrying it on the response
  // keeps offset arithmetic out of the client, and a host too old to page simply omits it — the
  // client then hides "Load more" instead of offering a button that re-requests page one forever.
  nextCursor?: GitHistoryCursor
}

export type GitHistoryExecutor = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
