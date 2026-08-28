import type { ClassifiedError } from '../../../../shared/classified-error'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import type {
  GitHubCommentResult,
  GitHubReactionContent,
  PRComment
} from '../../../../shared/github/comment-types'
import type {
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason
} from '../../../../shared/github/pull-request-refresh-types'
import type {
  GitHubOwnerRepo,
  IssueInfo,
  PRInfo
} from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { IssueSourcePreference } from '../../../../shared/repo-types'
import type {
  GitHubProjectFieldMutationValue,
  GitHubProjectTable
} from '../../../../shared/github/project-types'
import type {
  GetProjectViewTableResult,
  GitHubProjectMutationResult
} from '../../../../shared/github/project-result-types'
import type { GetProjectViewTableArgs } from '../../../../shared/github/project-request-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type {
  CacheEntry,
  FetchOptions,
  GitHubPatchWorkItemOptions,
  GitHubPRFallbackSource,
  ProjectRowContentPatch,
  ProjectRowContentUpdate,
  ProjectViewCacheEntry,
  RepoScopedFetchOptions,
  WorkItemsCacheError,
  WorkItemsCacheSources
} from './cache-model'
import type { PRRefreshState, PRRefreshStateClearToken } from './pr-refresh-state'

export type GitHubSlice = {
  prCache: Record<string, CacheEntry<PRInfo>>
  issueCache: Record<string, CacheEntry<IssueInfo>>
  checksCache: Record<string, CacheEntry<PRCheckDetail[]>>
  commentsCache: Record<string, CacheEntry<PRComment[]>>
  prRefreshSequences: Record<string, number>
  prRefreshStates: Record<string, PRRefreshState>
  prVisibleRefreshGeneration: number
  // Why: keyed by repoId + limit + query so same-path repos on different SSH targets don't share results.
  workItemsCache: Record<string, CacheEntry<readonly GitHubWorkItem[]>>
  fetchPRForBranch: (
    repoPath: string,
    branch: string,
    options?: RepoScopedFetchOptions & {
      worktreeId?: string
      linkedPRNumber?: number | null
      fallbackPRNumber?: number | null
      fallbackPRSource?: GitHubPRFallbackSource | null
    }
  ) => Promise<PRInfo | null>
  fetchIssue: (
    repoPath: string,
    number: number,
    options?: RepoScopedFetchOptions
  ) => Promise<IssueInfo | null>
  fetchPRChecks: (
    repoPath: string,
    prNumber: number,
    branch?: string,
    headSha?: string,
    prRepo?: GitHubOwnerRepo | null,
    options?: RepoScopedFetchOptions
  ) => Promise<PRCheckDetail[]>
  fetchPRCheckDetails: (
    repoPath: string,
    args: {
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    },
    options?: RepoScopedFetchOptions
  ) => Promise<PRCheckRunDetails | null>
  fetchPRComments: (
    repoPath: string,
    prNumber: number,
    options?: RepoScopedFetchOptions & { prRepo?: GitHubOwnerRepo | null }
  ) => Promise<PRComment[]>
  addPRConversationComment: (
    repoPath: string,
    prNumber: number,
    body: string,
    options?: RepoScopedFetchOptions & { prRepo?: GitHubOwnerRepo | null }
  ) => Promise<GitHubCommentResult>
  addPRReviewCommentReply: (
    repoPath: string,
    prNumber: number,
    commentId: number,
    body: string,
    options?: RepoScopedFetchOptions & {
      prRepo?: GitHubOwnerRepo | null
      threadId?: string
      path?: string
      line?: number
    }
  ) => Promise<GitHubCommentResult>
  setPRCommentReaction: (
    repoPath: string,
    prNumber: number,
    reactionSubjectId: string,
    content: GitHubReactionContent,
    reacted: boolean,
    options?: RepoScopedFetchOptions & { prRepo?: GitHubOwnerRepo | null }
  ) => Promise<boolean>
  resolveReviewThread: (
    repoPath: string,
    prNumber: number,
    threadId: string,
    resolve: boolean,
    options?: RepoScopedFetchOptions & { prRepo?: GitHubOwnerRepo | null }
  ) => Promise<boolean>
  initGitHubCache: () => Promise<void>
  refreshAllGitHub: () => void
  refreshGitHubForWorktree: (worktreeId: string) => void
  refreshGitHubForWorktreeIfStale: (worktreeId: string) => void
  enqueueGitHubPRRefresh: (
    worktreeId: string,
    reason: GitHubPRRefreshReason,
    priority?: number
  ) => void
  reportVisibleGitHubPRRefreshCandidates: (worktreeIds: string[], generation: number) => void
  bumpGitHubPRVisibleRefreshGeneration: () => void
  applyGitHubPRRefreshEvent: (event: GitHubPRRefreshEvent) => void
  getEffectiveGitHubPRRefreshState: (cacheKey: string, now?: number) => PRRefreshState | undefined
  expireGitHubPRRefreshState: (
    cacheKey: string,
    token: PRRefreshStateClearToken,
    now?: number
  ) => void
  /** SWR: returns cached work items immediately (null if none) and fires a background refresh when stale. */
  getCachedWorkItems: (
    repoId: string,
    limit: number,
    query: string,
    repoPath?: string,
    sourceContext?: TaskSourceContext | null
  ) => readonly GitHubWorkItem[] | null
  /** Returns a thin view (sources + error, never items) so it stays a cheap selector without dragging the whole work-item array through the equality check. */
  getWorkItemsSourcesAndError: (
    repoId: string,
    limit: number,
    query: string,
    repoPath?: string
  ) => { sources: WorkItemsCacheSources | null; error: WorkItemsCacheError | null }
  /**
   * Falls back to any `${repoPath}::` cache entry with resolved sources when the primary entry isn't populated yet — sources are repo-level (query-independent), so any sibling is safe to reuse.
   * Returns a single stable reference so the dialog can subscribe to just this selector; entries are replaced (not mutated) on write, preserving reference equality between unchanged entries.
   */
  getWorkItemsAnySourcesForRepo: (
    repoId: string,
    limit: number,
    repoPath?: string
  ) => WorkItemsCacheSources | null
  fetchWorkItems: (
    repoId: string,
    repoPath: string,
    limit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<readonly GitHubWorkItem[]>
  /**
   * Fan out one work-item query across repos; partial failures don't reject — a repo with no cached fallback increments `failedCount`, but one served stale cache on rejection isn't counted.
   * `githubUnavailable`: every selected GitHub source refresh failed because GitHub was unreachable (5xx/network/rate-limit), even if stale cache remains — lets the caller attribute the stale/empty list.
   */
  fetchWorkItemsAcrossRepos: (
    repos: {
      repoId: string
      path: string
      executionHostId?: string | null
      sourceContext?: TaskSourceContext | null
    }[],
    perRepoLimit: number,
    displayLimit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<{
    items: GitHubWorkItem[]
    failedCount: number
    githubUnavailable: boolean
    requestFailureCount?: number
  }>
  /** Fetch one numbered provider page. Pagination pages remain renderer-local. */
  fetchWorkItemsNextPage: (
    repos: {
      repoId: string
      path: string
      executionHostId?: string | null
      sourceContext?: TaskSourceContext | null
    }[],
    perRepoLimit: number,
    displayLimit: number,
    query: string,
    page: number,
    options?: Pick<FetchOptions, 'noCache' | 'requireComplete'>
  ) => Promise<{
    items: GitHubWorkItem[]
    failedCount: number
    errorTypes: ClassifiedError['type'][]
  }>
  /** Count items and derive pages from the largest per-repo result set. */
  countWorkItemsAcrossRepos: (
    repos: {
      repoId: string
      path: string
      executionHostId?: string | null
      sourceContext?: TaskSourceContext | null
    }[],
    query: string,
    perRepoLimit: number
  ) => Promise<{ totalCount: number; totalPages: number }>
  /** Fire-and-forget prefetch to warm the cache before the page mounts (hover/focus of the "new workspace" buttons). */
  prefetchWorkItems: (
    repoId: string,
    repoPath: string,
    limit?: number,
    query?: string,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  patchWorkItem: (
    itemId: string,
    patch: Partial<GitHubWorkItem>,
    repoId?: string | null,
    options?: GitHubPatchWorkItemOptions
  ) => void
  /** Monotonic counter bumped on issue-source preference flips; subscribers include it in their deps to force a re-fetch, since cache eviction alone won't trip effects keyed on selectedRepos/search/nonce. */
  workItemsInvalidationNonce: number
  /** Persist the preference, update the local Repo record, and invalidate all `${repoId}::*` cache keys — not just the primary — so alternate-query lines don't serve stale results after the source flips. */
  setIssueSourcePreference: (
    repoId: string,
    repoPath: string,
    preference: IssueSourcePreference
  ) => Promise<void>
  evictGitHubRepoCaches: (repoId: string, repoPath?: string) => void
  // ── ProjectV2 view cache ─────────────────────────────────────────────
  projectViewCache: Record<string, ProjectViewCacheEntry<GitHubProjectTable>>
  fetchProjectViewTable: (
    args: GetProjectViewTableArgs,
    options?: FetchOptions
  ) => Promise<GetProjectViewTableResult>
  updateProjectFieldValue: (
    cacheKey: string,
    rowId: string,
    fieldId: string,
    value: GitHubProjectFieldMutationValue
  ) => Promise<GitHubProjectMutationResult>
  clearProjectFieldValue: (
    cacheKey: string,
    rowId: string,
    fieldId: string
  ) => Promise<GitHubProjectMutationResult>
  patchProjectIssueOrPr: (
    cacheKey: string,
    rowId: string,
    updates: ProjectRowContentUpdate
  ) => Promise<GitHubProjectMutationResult>
  patchProjectRowIssueType: (
    cacheKey: string,
    rowId: string,
    issueType: { id: string; name: string; color: string | null; description: string | null } | null
  ) => Promise<GitHubProjectMutationResult>
  /** Optimistic, IPC-free patcher for a single `projectViewCache` row's `content`; `patchWorkItem` only walks `workItemsCache` and would leave the Project view stale until the next refresh. */
  patchProjectRowContent: (cacheKey: string, rowId: string, patch: ProjectRowContentPatch) => void
}
