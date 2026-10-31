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
  // Effective submodule.recurse makes parent restore reset the checkout; older hosts omit it.
  restoreRecurses?: boolean
}

// Legacy consumers may use modified styling, but unresolved conflicts must not offer file-dependent diff/drag/edit actions: both_deleted may have no file.
// This applies outside Source Control too (explorer/tab badges). Renderer alone stamps conflictStatusSource: git for live u rows, session for resolved locally.
export type GitUncommittedEntry = {
  path: string
  status: GitFileStatus
  area: GitStagingArea
  oldPath?: string
  conflictKind?: GitConflictKind
  conflictStatus?: GitConflictResolutionStatus
  conflictStatusSource?: GitConflictStatusSource
  submodule?: GitSubmoduleStatus
  // Submodule-internal entries carry the parent-relative submodule root for diff routing and read-only gating; parent staging cannot modify them.
  submoduleRoot?: string
  // Counts describe this staging area; untracked contents are additions. Undefined means binary or unavailable.
  added?: number
  removed?: number
}

export type GitStatusEntry = GitUncommittedEntry

// Merge base → working tree, deduplicated, so committing doesn't move it.
// Matches the per-file rows rather than git: binary and >2MB untracked count zero.
// `mergeBase` echoes the common ancestor OID to reject stale totals.
export type GitBranchLineTotal = {
  added: number
  removed: number
  mergeBase: string
  // Path-heuristic buckets of added/removed; generated wins on overlap. Optional
  // for pre-split hosts (absent = unknown, not zero).
  test?: { added: number; removed: number }
  generated?: { added: number; removed: number }
}

export type GitStatusResult = {
  entries: GitStatusEntry[]
  conflictOperation: GitConflictOperation
  head?: string
  branch?: string
  // Reuse porcelain v2 upstream/ahead/behind metadata to avoid two extra refresh subprocesses.
  upstreamStatus?: GitUpstreamStatus
  ignoredPaths?: string[]
  // Stop oversized Git output before buffering can crash. entries keeps the first limit rows; statusLength counts rows seen before stopping.
  // Optional for older consumers; didHitLimit drives the SCM too-many-changes state.
  didHitLimit?: boolean
  statusLength?: number
  // Only computed when the request carried a merge-base OID (the renderer's
  // visibility gate). Omission means deferred, skipped, or an older host.
  branchLineTotal?: GitBranchLineTotal
  // Explicitly invalidates a previously published total for this merge-base OID.
  // Kept separate so older hosts/clients remain compatible with omitted totals.
  branchLineTotalUnavailable?: string
  // Git's error when status could not be read; empty entries then do not mean a clean tree.
  readError?: string
}

// Without hasUpstream, ahead/behind 0/0 are placeholders, not proof of sync. Explicit upstream refreshes can fail independently of worktree status.
export type GitUpstreamStatus = {
  hasUpstream: boolean
  upstreamName?: string
  ahead: number
  behind: number
  /** True when push can target configured branch push metadata even though
   * upstream/ahead-behind cannot be resolved. */
  hasConfiguredPushTarget?: boolean
  // Rebases can leave older patch-equivalent upstream commits; pulling restores stale history, requiring lease-protected force push instead.
  behindCommitsArePatchEquivalent?: boolean
}

export type GitBranchChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
