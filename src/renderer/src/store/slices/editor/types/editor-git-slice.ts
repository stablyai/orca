import type { RemoteOpKind } from '@/components/right-sidebar/source-control-primary-action'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type {
  GitBranchLineTotal,
  GitConflictKind,
  GitConflictOperation,
  GitOperationProgress,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../../../shared/git-status-types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { PendingEditorFocusRequest, PendingEditorReveal } from './pending-editor-reveal'
import type { FileSearchWorktreeState } from './file-search-worktree-state'
import type { GitRuntimeOperationOptions } from './git-runtime-operation'

export type EditorGitSlice = {
  // Cursor line tracking per file
  editorCursorLine: Record<string, number>
  setEditorCursorLine: (fileId: string, line: number) => void

  // Git status cache
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  gitStatusHeadByWorktree: Record<string, string>
  // Why: set when status hit the entry limit; SCM shows "too many changes" and pauses polling. `{ limit }` when huge, else absent.
  gitStatusHugeByWorktree: Record<string, { limit: number }>
  // Why: absent means "not known exact" (stale fork point, old server, capped listing); never fall back to a previous total.
  gitBranchLineTotalByWorktree: Record<string, GitBranchLineTotal | null>
  gitIgnoredPathsByWorktree: Record<string, string[]>
  gitConflictOperationByWorktree: Record<string, GitConflictOperation>
  // Why: absent means the host never reported progress (old host, capped snapshot,
  // unreadable state dir) — the banner must degrade, not render "step 0 of 0".
  gitOperationProgressByWorktree: Record<string, GitOperationProgress>
  trackedConflictPathsByWorktree: Record<string, Record<string, GitConflictKind>>
  trackConflictPath: (worktreeId: string, path: string, conflictKind: GitConflictKind) => void
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  // Why: clears stale Rebasing/Merging badges on non-active worktrees without a full git status poll.
  setConflictOperation: (worktreeId: string, operation: GitConflictOperation) => void
  remoteStatusesByWorktree: Record<string, GitUpstreamStatus>
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  // Why: refcount-backed busy flag; a bare boolean races across worktrees (A finishing re-enables B mid-flight). begin/end must be paired.
  isRemoteOperationActive: boolean
  remoteOperationDepth: number
  // Why: which remote op the user triggered, so the primary button mirrors its label+spinner; cleared at depth 0.
  inFlightRemoteOpKind: RemoteOpKind | null
  beginRemoteOperation: (kind?: RemoteOpKind) => void
  endRemoteOperation: () => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<GitUpstreamStatus | null>
  pushBranch: (
    worktreeId: string,
    worktreePath: string,
    publish?: boolean,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions & { forceWithLease?: boolean }
  ) => Promise<void>
  pullBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  fastForwardBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  syncBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  rebaseFromBase: (
    worktreeId: string,
    worktreePath: string,
    baseRef: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  fetchBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  gitBranchChangesByWorktree: Record<string, GitBranchChangeEntry[]>
  gitBranchCompareSummaryByWorktree: Record<string, GitBranchCompareSummary | null>
  gitBranchCompareRequestKeyByWorktree: Record<string, string>
  gitBranchCompareRequestStatusHeadByWorktree: Record<string, string | null>
  beginGitBranchCompareRequest: (
    worktreeId: string,
    requestKey: string,
    baseRef: string,
    options?: { preserveExistingSummary?: boolean }
  ) => void
  setGitBranchCompareResult: (
    worktreeId: string,
    requestKey: string,
    result: { summary: GitBranchCompareSummary; entries: GitBranchChangeEntry[] }
  ) => void
  clearGitBranchCompare: (worktreeId: string) => void

  // File search state
  fileSearchStateByWorktree: Record<string, FileSearchWorktreeState>
  updateFileSearchState: (worktreeId: string, updates: Partial<FileSearchWorktreeState>) => void
  seedFileSearchQuery: (worktreeId: string, query: string) => void
  seedFileSearchIncludePattern: (worktreeId: string, includePattern: string) => void
  consumeFileSearchSeedRequest: (worktreeId: string, seedRequestId: number) => void
  toggleFileSearchCollapsedFile: (worktreeId: string, filePath: string) => void
  clearFileSearch: (worktreeId: string) => void

  // Editor navigation (for search result → go-to-line)
  pendingEditorReveal: PendingEditorReveal | null
  setPendingEditorReveal: (reveal: PendingEditorReveal | null) => void
  pendingEditorFocusRequest: PendingEditorFocusRequest | null
  consumeEditorFocusRequest: (token: number) => void

  // Session hydration — restore editor files from persisted workspace session
  hydrateEditorSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}
