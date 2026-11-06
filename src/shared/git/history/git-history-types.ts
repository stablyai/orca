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
  /** Epoch milliseconds (git %at seconds × 1000). */
  timestamp?: number
  statistics?: GitHistoryItemStatistics
  references?: GitHistoryItemRef[]
  /** Set only for branch-only pages: whether the upstream already has this commit. */
  pushed?: boolean
}

export type GitHistoryOptions = {
  limit?: number
  baseRef?: string | null
  /** List only commits on HEAD that baseRef lacks, with statistics and pushed state. */
  branchOnly?: boolean
  skip?: number
}

export type GitHistoryBranchRange = {
  baseRef: GitHistoryItemRef
  /** Commits on HEAD that the base lacks. */
  ahead: number
  /** Commits on the base that HEAD lacks. */
  behind: number
  /** Commits among `ahead` that the upstream lacks; all of them when there is no upstream. */
  unpushed: number
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
  /** Present only when the page honoured branchOnly; older hosts omit it. */
  branch?: GitHistoryBranchRange
  /** Echoes a requested skip so clients can tell paging hosts from older ones. */
  skip?: number
}

export type GitHistoryExecutor = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
