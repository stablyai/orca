export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'
export type GitStagingArea = 'staged' | 'unstaged' | 'untracked'
export type GitConflictKind =
  | 'both_modified'
  | 'both_added'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'
  | 'deleted_by_us'
  | 'deleted_by_them'

export type GitConflictResolutionStatus = 'unresolved' | 'resolved_locally'
export type GitConflictStatusSource = 'git' | 'session'
export type GitConflictOperation = 'merge' | 'rebase' | 'cherry-pick' | 'unknown'
export type GitSubmoduleStatus = {
  commitChanged: boolean
  trackedChanges: boolean
  untrackedChanges: boolean
}

// Compatibility note for non-upgraded consumers:
// Any consumer that has not been upgraded to read `conflictStatus` may still
// render `modified` styling via the `status` field (which is a compatibility
// fallback, not a semantic claim). However, such consumers must NOT offer
// file-existence-dependent affordances (diff loading, drag payloads, editable-
// file opening) for entries where `conflictStatus === 'unresolved'` — the file
// may not exist on disk (e.g. both_deleted). This affects file explorer
// decorations, tab badges, and any surface outside Source Control.
//
// `conflictStatusSource` is never set by the main process. The renderer stamps
// 'git' for live u-records and 'session' for Resolved locally state.
export type GitUncommittedEntry = {
  path: string
  status: GitFileStatus
  area: GitStagingArea
  oldPath?: string
  conflictKind?: GitConflictKind
  conflictStatus?: GitConflictResolutionStatus
  conflictStatusSource?: GitConflictStatusSource
  submodule?: GitSubmoduleStatus
  // Working-tree line counts for this entry's staging area (staged vs unstaged
  // diffs are reported separately). Untracked files count their full contents
  // as additions. Undefined for binary files and when the diff is unavailable.
  added?: number
  removed?: number
}

export type GitStatusEntry = GitUncommittedEntry

export type GitStatusResult = {
  entries: GitStatusEntry[]
  conflictOperation: GitConflictOperation
  head?: string
  branch?: string
  // Why: porcelain v2 status already includes upstream/ahead/behind metadata.
  // Folding it in lets refresh polling avoid a second pair of git subprocesses.
  upstreamStatus?: GitUpstreamStatus
  ignoredPaths?: string[]
  // Why: a repo with an enormous un-ignored folder can emit a status listing big
  // enough to crash the process when buffered. Status is capped at an entry
  // limit; when the cap is hit, `entries` holds the first `limit` rows,
  // `didHitLimit` is true, and `statusLength` is the total seen before git was
  // stopped. Optional so un-upgraded consumers keep working. See the SCM
  // "too many changes" state.
  didHitLimit?: boolean
  statusLength?: number
}

// Why: when hasUpstream is false, ahead/behind are placeholder zeros, not a
// "sync" signal — callers must check hasUpstream before treating 0/0 as in-sync.
// Kept as a named type because explicit upstream refreshes can still fail for
// reasons unrelated to working-tree status (e.g., no upstream is expected).
export type GitUpstreamStatus = {
  hasUpstream: boolean
  upstreamName?: string
  ahead: number
  behind: number
  /** True when push can target configured branch push metadata even though
   * upstream/ahead-behind cannot be resolved. */
  hasConfiguredPushTarget?: boolean
  // Why: when a branch was rebased, the upstream-only commits can be older
  // patch-equivalent copies. Pulling them reintroduces stale history; a
  // lease-protected force push is the correct reconciliation.
  behindCommitsArePatchEquivalent?: boolean
}

export type GitBranchChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
