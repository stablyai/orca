// Share nonplain editor views with runtime layout records and renderer open files.

import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareSummary
} from './git-diff-compare-types'
import type {
  GitConflictKind,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitStatusEntry
} from './git-status-types'
import type { GitLabProjectRef } from './gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from './github/check-types'
import type { GitHubRepositoryIdentity } from './github/pull-request-types'

export type DiffSource =
  | 'unstaged'
  | 'staged'
  | 'branch'
  | 'commit'
  | 'combined-all'
  | 'combined-uncommitted'
  | 'combined-branch'
  | 'combined-commit'

export type BranchCompareSnapshot = Pick<
  GitBranchCompareSummary,
  'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'
> & {
  compareVersion: string
}

export type CommitCompareSnapshot = Pick<
  GitCommitCompareSummary,
  'commitOid' | 'parentOid' | 'compareRef' | 'baseRef'
> & {
  compareVersion: string
  subject?: string
  message?: string
}

export type CombinedDiffAlternate = {
  source: 'combined-all' | 'combined-branch'
  branchCompare?: BranchCompareSnapshot
}

export type OpenConflictMetadata = {
  kind: 'conflict-editable' | 'conflict-placeholder'
  conflictKind: GitConflictKind
  conflictStatus: GitConflictResolutionStatus
  conflictStatusSource: GitConflictStatusSource
  message?: string
  guidance?: string
}

export type ConflictReviewEntry = {
  path: string
  conflictKind: GitConflictKind
}

export type ConflictReviewState = {
  source: 'live-summary' | 'combined-diff-exclusion'
  snapshotTimestamp: number
  entries: ConflictReviewEntry[]
  selectedFileId?: string
}

export type CombinedDiffSkippedConflict = {
  path: string
  conflictKind: GitConflictKind
}

export type OpenCheckRunDetailsState = {
  contextKey: string
  check: PRCheckDetail
  requestId?: number
  details: PRCheckRunDetails | null
  loading: boolean
  error: string | null
  githubRepository?: GitHubRepositoryIdentity | null
  /** Why: fork/cross-project MR jobs live outside the repo's own project, so reloads need the pipeline's project. */
  gitlabProjectRef?: GitLabProjectRef | null
}

/** An editor tab's view, keyed by its mode, with exactly the open-file fields that mode uses today. The view is not saved. */
export type EditorTabView =
  | { mode: 'edit'; conflict: OpenConflictMetadata }
  | {
      mode: 'diff'
      diffSource?: DiffSource
      branchCompare?: BranchCompareSnapshot
      commitCompare?: CommitCompareSnapshot
      branchOldPath?: string
      combinedAlternate?: CombinedDiffAlternate
      combinedAreaFilter?: string
      branchEntriesSnapshot?: GitBranchChangeEntry[]
      commitEntriesSnapshot?: GitBranchChangeEntry[]
      uncommittedEntriesSnapshot?: GitStatusEntry[]
      skippedConflicts?: CombinedDiffSkippedConflict[]
    }
  | {
      mode: 'markdown-preview'
      markdownPreviewSourceFileId?: string
      markdownPreviewAnchor?: string
    }
  | { mode: 'conflict-review'; conflictReview?: ConflictReviewState }
  | { mode: 'check-details'; checkRunDetails?: OpenCheckRunDetailsState }
