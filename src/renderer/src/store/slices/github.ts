/* eslint-disable max-lines -- Why: the GitHub slice co-locates all cache + fetch logic for
PR, issue, checks, and comments data so the dedup and invalidation patterns stay consistent. */
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  ClassifiedError,
  GitHubOwnerRepo,
  GitHubPRRefreshAlias,
  IssueSourcePreference,
  PRInfo,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubCommentResult,
  IssueInfo,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment,
  Repo,
  Worktree,
  GitHubWorkItem,
  ListWorkItemsResult
} from '../../../../shared/types'
import type {
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectFieldMutationValue,
  GitHubProjectMutationResult,
  GitHubProjectRow,
  GitHubProjectTable,
  GitHubProjectViewError
} from '../../../../shared/github-project-types'
import {
  isGitHubWorkItemsSshRemoteRequiredError,
  sortWorkItemsByUpdatedAt,
  PER_REPO_FETCH_LIMIT
} from '../../../../shared/work-items'
import { deriveCheckStatusFromChecks, syncPRChecksStatus } from './github-checks'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { getHostedReviewCacheKey, linkedReviewHintKey } from './hosted-review-cache-identity'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from './github-cache-key'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { translate } from '@/i18n/i18n'

// ─── ProjectV2 cache types ────────────────────────────────────────────
// Why: declared separately from CacheEntry<T> (not a generified E parameter)
// because project-view has a single GraphQL source — no issue/PR-source
// fallback — and the error union is distinct. Shared structural shape only.
export type ProjectViewCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  error?: GitHubProjectViewError
}

export type ProjectRowContentUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

/** Optimistic, IPC-free patch shape for `projectViewCache` rows.
 *  Why: the dialog already issues mutations via slug-addressed IPCs and only
 *  needs to keep the Project table view in sync optimistically. Replacing
 *  `addLabels`/`removeLabels` deltas with full `labels`/`assignees` arrays
 *  matches what the dialog's local state already tracks (`localLabels`,
 *  `localAssignees`) and avoids redundant set-merge logic at the call site. */
export type ProjectRowContentPatch = {
  title?: string
  body?: string
  /** Why: accept the renderer's lowercase work-item state vocabulary
   *  ('open' | 'closed' | 'merged' | 'draft') and translate to GitHub's
   *  UPPERCASE row.content.state when applying. The reducer only writes
   *  what callers send; merged/draft are passed through for completeness
   *  even though the dialog edits only flip open↔closed today. */
  state?: 'open' | 'closed' | 'merged' | 'draft'
  labels?: string[]
  assignees?: string[]
}

// Why: queryOverride participates in the cache key so an overridden search
// does not clobber the default-view cache entry, and vice versa. `undefined`
// means "use the view's stored filter" — the unfiltered cache entry. An
// empty string is a *distinct* override meaning "no filter", which produces
// different rows when the view's stored filter is non-empty, so it gets its
// own cache key.
function queryOverrideKeyPart(queryOverride: string | undefined): string {
  if (queryOverride === undefined) {
    return ''
  }
  return `:q=${queryOverride}`
}

function getRuntimeRepoTarget(
  state: AppState,
  repoPath: string,
  settings: AppState['settings'] = state.settings
): { target: { kind: 'environment'; environmentId: string }; repo: Repo } | null {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.path === repoPath)
  return repo ? { target, repo } : null
}

type GitHubWorkItemRequestContext = {
  repoId: string
  repoPath: string
  target: GitHubWorkItemRequestTarget
}

type GitHubWorkItemRequestTarget =
  | { kind: 'environment'; environmentId: string; runtimeRepoId: string }
  | { kind: 'local' }

type GitHubWorkItemsListArgs = {
  limit: number
  query?: string
  before?: string
  noCache?: true
}

function activeRuntimeEnvironmentId(settings: AppState['settings']): string | null {
  return settings?.activeRuntimeEnvironmentId ?? null
}

function getGitHubWorkItemRequestContext(
  state: AppState,
  settings: AppState['settings'],
  repoId: string,
  repoPath: string
): GitHubWorkItemRequestContext {
  const runtimeRepo = getRuntimeRepoTarget(state, repoPath, settings)
  return {
    repoId,
    repoPath,
    target: runtimeRepo
      ? {
          kind: 'environment',
          environmentId: runtimeRepo.target.environmentId,
          runtimeRepoId: runtimeRepo.repo.id
        }
      : { kind: 'local' }
  }
}

function listGitHubWorkItemsForRepo(
  context: GitHubWorkItemRequestContext,
  args: GitHubWorkItemsListArgs
): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> {
  if (context.target.kind === 'environment') {
    return callRuntimeRpc<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>(
      { kind: 'environment', environmentId: context.target.environmentId },
      'github.listWorkItems',
      {
        repo: context.target.runtimeRepoId,
        ...args
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.listWorkItems({
    repoPath: context.repoPath,
    repoId: context.repoId,
    ...args
  })
}

function countGitHubWorkItemsForRepo(
  context: GitHubWorkItemRequestContext,
  args: { query?: string }
): Promise<number> {
  if (context.target.kind === 'environment') {
    return callRuntimeRpc<number>(
      { kind: 'environment', environmentId: context.target.environmentId },
      'github.countWorkItems',
      {
        repo: context.target.runtimeRepoId,
        ...args
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.countWorkItems({
    repoPath: context.repoPath,
    repoId: context.repoId,
    ...args
  })
}

export function projectViewCacheKey(
  ownerType: GetProjectViewTableArgs['ownerType'],
  owner: string,
  projectNumber: number,
  resolvedViewId: string,
  queryOverride?: string
): string {
  return `github-project:${ownerType}:${owner}:${projectNumber}:${resolvedViewId}${queryOverrideKeyPart(queryOverride)}`
}

function projectViewRequestKey(args: GetProjectViewTableArgs): string {
  // Why: callers without `viewId` can't compute the resolved cache key up
  // front. Use the input-arg signature for inflight dedup; the resolved
  // cache key is only known after the main-process IPC returns.
  const selector = args.viewId
    ? `id:${args.viewId}`
    : args.viewNumber !== undefined
      ? `num:${args.viewNumber}`
      : args.viewName
        ? `name:${args.viewName}`
        : 'default'
  return `${args.ownerType}:${args.owner}:${args.projectNumber}:${selector}${queryOverrideKeyPart(args.queryOverride)}`
}

// Why: module-scope inflight map — must mirror `inflightWorkItemsRequests`
// (dedup + force-refresh semantics). Reuses the work-item concurrency gate:
// the gate exists to bound `gh` subprocess pressure at the renderer boundary,
// and project-view fetches pressure the same subprocess budget. Two separate
// gates would let concurrent Project + work-item fetches blow past the cap.
const inflightProjectViewRequests = new Map<
  string,
  { promise: Promise<GetProjectViewTableResult>; force: boolean }
>()

// Why: derive an optimistic GitHubProjectFieldValue from a mutation value so
// the patched row re-renders immediately. Single-select and iteration lookups
// consult the field config on the cached table; the result is best-effort and
// is overwritten by the authoritative payload on next refresh.
function optimisticFieldValueFromMutation(
  table: GitHubProjectTable,
  fieldId: string,
  value: GitHubProjectFieldMutationValue
): GitHubProjectTable['rows'][number]['fieldValuesByFieldId'][string] | null {
  const field = table.selectedView.fields.find((f) => f.id === fieldId)
  switch (value.kind) {
    case 'single-select': {
      if (field?.kind === 'single-select') {
        const option = field.options.find((o) => o.id === value.optionId)
        if (option) {
          return {
            kind: 'single-select',
            fieldId,
            optionId: option.id,
            name: option.name,
            color: option.color
          }
        }
      }
      return {
        kind: 'single-select',
        fieldId,
        optionId: value.optionId,
        name: '',
        color: ''
      }
    }
    case 'iteration': {
      if (field?.kind === 'iteration') {
        const iteration = field.iterations.find((i) => i.id === value.iterationId)
        if (iteration) {
          return {
            kind: 'iteration',
            fieldId,
            iterationId: iteration.id,
            title: iteration.title,
            startDate: iteration.startDate,
            duration: iteration.duration
          }
        }
      }
      return {
        kind: 'iteration',
        fieldId,
        iterationId: value.iterationId,
        title: '',
        startDate: '',
        duration: 0
      }
    }
    case 'text':
      return { kind: 'text', fieldId, text: value.text }
    case 'number':
      return { kind: 'number', fieldId, number: value.number }
    case 'date':
      return { kind: 'date', fieldId, date: value.date }
  }
  return null
}

function applyRowPatch(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  cacheKey: string,
  rowId: string,
  nextRow: GitHubProjectRow
): void {
  set((s) => {
    const entry = s.projectViewCache[cacheKey]
    if (!entry?.data) {
      return {}
    }
    const rowIndex = entry.data.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {}
    }
    const rows = [...entry.data.rows]
    rows[rowIndex] = nextRow
    return {
      projectViewCache: {
        ...s.projectViewCache,
        [cacheKey]: {
          ...entry,
          data: { ...entry.data, rows }
        }
      }
    }
  })
}

function rollbackRowIfPresent(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  cacheKey: string,
  rowId: string,
  previousRow: GitHubProjectRow
): void {
  // Why: the cache entry may have moved (rapid project switch) or the row may
  // no longer exist by the time the mutation response returns. Skip rollback
  // in that case — resurrecting stale data into a newly selected project would
  // show the wrong row.
  const entry = get().projectViewCache[cacheKey]
  if (!entry?.data) {
    return
  }
  const stillPresent = entry.data.rows.some((r) => r.id === rowId)
  if (!stillPresent) {
    return
  }
  applyRowPatch(set, cacheKey, rowId, previousRow)
}

function parseSlugAndNumber(
  row: GitHubProjectRow
): { owner: string; repo: string; number: number } | null {
  if (!row.content.repository || row.content.number == null) {
    return null
  }
  const parts = row.content.repository.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }
  return { owner: parts[0], repo: parts[1], number: row.content.number }
}

export type WorkItemsCacheSources = {
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  /** Raw upstream remote (if any) — present so the selector can render
   *  independently of the currently-effective preference. Required-nullable
   *  (matches siblings `issues`/`prs`) so consumers only branch on `null`
   *  vs value, not a three-state (undefined | null | value). */
  upstreamCandidate: GitHubOwnerRepo | null
}

// Why: the indicator and retry banner both need the resolved owner/repo for
// the failing side. Stamping the slug onto the error keeps the banner copy
// correct even when the error outlives the cache entry's `sources` field
// (e.g. on partial-success merges where `data` is retained from a later read).
export type WorkItemsCacheError = ClassifiedError & { source: GitHubOwnerRepo }

export type CacheEntry<T> = {
  data: T | null
  fetchedAt: number
  headSha?: string
  /**
   * Resolved issue/PR owner/repo slugs for this entry. Set only on entries
   * populated by `fetchWorkItems` — PR and issue single-item caches don't
   * carry sources since the indicator surfaces derive from list reads.
   */
  sources?: WorkItemsCacheSources
  /**
   * Per-side classified error. Present when one (or both) of the underlying
   * gh list calls failed. Partial-success reads keep `data` from the
   * successful side and record the failing side here so the banner + list
   * render together.
   */
  error?: WorkItemsCacheError
  /**
   * True when the resolver fell back to origin because the user's preferred
   * `'upstream'` remote is no longer configured for this repo. Consumers
   * surface a one-time toast per session/repo; TaskPage tracks the
   * already-toasted set so repeated refreshes don't re-toast.
   * Typed as `?: true` (not `?: boolean`) to encode the invariant "present
   * iff fell-back" — an explicit `false` write would be a bug.
   */
  issueSourceFellBack?: true
}

type FetchOptions = {
  force?: boolean
  noCache?: boolean
}

type RepoScopedFetchOptions = FetchOptions & {
  repoId?: string
}

type PRRefreshState = {
  status: 'queued' | 'in-flight' | 'paused' | 'skipped' | 'error'
  reason: GitHubPRRefreshReason
  updatedAt: number
  pausedUntil?: number
  message?: string
}

function bypassesGitHubPRRefreshFreshness(reason: GitHubPRRefreshReason): boolean {
  return reason === 'manual' || reason === 'active' || reason === 'post-push'
}

const CACHE_TTL = 300_000 // 5 minutes (stale data shown instantly, then refreshed)
const CHECKS_CACHE_TTL = 60_000 // 1 minute — checks change more frequently
// Why: the NewWorkspace page's work-item list is a browse surface, not a
// source of truth, so 60s staleness is fine — stale data renders instantly
// while a background refresh keeps it current.
const WORK_ITEMS_CACHE_TTL = 60_000
// Why: match repos.ts so error toasts surfaced from this slice share the same
// long-lived duration — the user needs time to read + act on persist failures
// rather than having the toast vanish behind default short-lived timings.
const ERROR_TOAST_DURATION = 60_000

const inflightPRRequests = new Map<
  string,
  { promise: Promise<PRInfo | null>; force: boolean; generation: number; lookupHintKey: string }
>()
const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
const inflightChecksRequests = new Map<string, Promise<PRCheckDetail[]>>()
const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
type InflightWorkItems = {
  promise: Promise<GitHubWorkItem[]>
  force: boolean
  noCache: boolean
}
const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
const prRequestGenerations = new Map<string, number>()
const prRefreshStartedHostedReviewEntries = new Map<
  string,
  AppState['hostedReviewCache'][string] | undefined
>()
const PR_REFRESH_STARTED_HOSTED_REVIEW_ENTRY_MAX = 128

/** @internal - exposed for leak-regression tests only */
export function _getGitHubPRRequestGenerationCountForTest(): number {
  return prRequestGenerations.size
}

/** @internal - exposed for leak-regression tests only */
export function _getGitHubPRRefreshStartedEntryCountForTest(): number {
  return prRefreshStartedHostedReviewEntries.size
}

/** @internal - exposed for leak-regression tests only */
export function _clearGitHubPRRefreshStartedEntriesForTest(): void {
  prRefreshStartedHostedReviewEntries.clear()
}

// Why: cap in-flight cross-repo fan-out and hover-prefetches at the renderer
// boundary — the main-side gate is behind the IPC queue, so it can't see a
// stampede until the calls are already mid-flight. 8 balances responsiveness
// against gh rate-limit pressure.
const WORK_ITEM_FETCH_CONCURRENCY = 8
let workItemFetchInFlight = 0
const workItemFetchWaiters: (() => void)[] = []

async function acquireWorkItemSlot(): Promise<void> {
  if (workItemFetchInFlight < WORK_ITEM_FETCH_CONCURRENCY) {
    workItemFetchInFlight += 1
    return
  }
  await new Promise<void>((resolve) => workItemFetchWaiters.push(resolve))
  // Why: resolver has already claimed the slot on our behalf, so we don't
  // re-increment here. Pairing convention: acquireWorkItemSlot + releaseWorkItemSlot.
}

function releaseWorkItemSlot(): void {
  const next = workItemFetchWaiters.shift()
  if (next) {
    // Hand the slot off directly — net count unchanged — so we can't race a
    // third caller into the cap between decrement and resolve.
    next()
    return
  }
  workItemFetchInFlight -= 1
}

export function workItemsCacheKey(repoId: string, limit: number, query: string): string {
  return `${repoId}::${limit}::${query}`
}

function workItemsInflightRequestKey(
  cacheKey: string,
  target: GitHubWorkItemRequestTarget
): string {
  const targetPart =
    target.kind === 'environment' ? `env:${target.environmentId}:${target.runtimeRepoId}` : 'local'
  return `${cacheKey}::${targetPart}`
}

function repoScopedCacheKey(repoPath: string, repoId: string | undefined, suffix: string): string {
  return `${repoId ?? repoPath}::${suffix}`
}

function runtimeScopedRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string,
  settings?: AppState['settings'],
  connectionId?: string | null
): string {
  return getGitHubRepoCacheKey(repoPath, repoId, suffix, settings, connectionId)
}

function prCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string,
  settings?: AppState['settings'],
  connectionId?: string | null
): string {
  return getGitHubPRCacheKey(repoPath, repoId, branch, settings, connectionId)
}

function repoCacheKeyPrefixes(repoId: string, repoPath?: string): string[] {
  const prefixes = [`${repoId}::`]
  if (repoPath && repoPath !== repoId) {
    prefixes.push(`${repoPath}::`)
  }
  return prefixes
}

function matchesRepoCacheKey(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix))
}

function clearInflightWorkItemsForRepo(repoId: string, repoPath?: string): void {
  const prefixes = repoCacheKeyPrefixes(repoId, repoPath)
  for (const key of Array.from(inflightWorkItemsRequests.keys())) {
    if (matchesRepoCacheKey(key, prefixes)) {
      inflightWorkItemsRequests.delete(key)
    }
  }
}

function evictRepoCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  prefixes: readonly string[]
): { cache: Record<string, CacheEntry<T>>; evicted: boolean } {
  let next: Record<string, CacheEntry<T>> | null = null
  for (const key of Object.keys(cache)) {
    if (!matchesRepoCacheKey(key, prefixes)) {
      continue
    }
    if (!next) {
      next = { ...cache }
    }
    delete next[key]
  }
  return next ? { cache: next, evicted: true } : { cache, evicted: false }
}

function normalizedRepoIdentity(repo: GitHubOwnerRepo): string {
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
}

function normalizedHeadSha(headSha?: string): string | null {
  const trimmed = headSha?.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

export function prChecksCacheSuffix(
  prNumber: number,
  prRepo?: GitHubOwnerRepo | null,
  headSha?: string
): string {
  const headSuffix = normalizedHeadSha(headSha)
  const base = prRepo
    ? `pr-checks::${normalizedRepoIdentity(prRepo)}::${prNumber}`
    : `pr-checks::${prNumber}`
  return headSuffix ? `${base}::head::${headSuffix}` : base
}

export function prCommentsCacheSuffix(prNumber: number, prRepo?: GitHubOwnerRepo | null): string {
  if (!prRepo) {
    return `pr-comments::${prNumber}`
  }
  return `pr-comments::${normalizedRepoIdentity(prRepo)}::${prNumber}`
}

function commentTimestamp(comment: PRComment): number {
  const timestamp = new Date(comment.createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function mergePRCommentIntoList(
  comments: readonly PRComment[] | null | undefined,
  incoming: PRComment
): PRComment[] {
  const byId = new Map<number, PRComment>()
  for (const comment of comments ?? []) {
    byId.set(comment.id, comment)
  }
  const previous = byId.get(incoming.id)
  byId.set(incoming.id, {
    ...previous,
    ...incoming,
    threadId: incoming.threadId ?? previous?.threadId,
    path: incoming.path ?? previous?.path,
    line: incoming.line ?? previous?.line,
    startLine: incoming.startLine ?? previous?.startLine,
    isResolved: incoming.isResolved ?? previous?.isResolved,
    isOutdated: incoming.isOutdated ?? previous?.isOutdated
  })
  return Array.from(byId.values()).sort((a, b) => commentTimestamp(a) - commentTimestamp(b))
}

function hasUsableCommentPayload(result: GitHubCommentResult): result is {
  ok: true
  comment: PRComment
} {
  return (
    result.ok &&
    typeof result.comment?.id === 'number' &&
    Number.isSafeInteger(result.comment.id) &&
    result.comment.id > 0 &&
    typeof result.comment.body === 'string' &&
    typeof result.comment.createdAt === 'string'
  )
}

// Why: 500 entries is generous enough that active developers will never hit it
// during normal use, but prevents the cache from growing without bound across
// many repos and branches over a long-running session.
const MAX_CACHE_ENTRIES = 500
type GitHubPRFallbackSource = NonNullable<GitHubPRRefreshAlias['fallbackPRSource']>

function isFresh<T>(entry: CacheEntry<T> | undefined, ttl = CACHE_TTL): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

function findWorktreeById(state: AppState, worktreeId: string): Worktree | null {
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (worktree) {
      return worktree
    }
  }
  return null
}

function buildPRRefreshCandidate(
  state: AppState,
  worktree: Worktree,
  repoPath?: string
): GitHubPRRefreshCandidate | null {
  const repo = state.repos.find((r) => r.id === worktree.repoId)
  if (!repo) {
    return null
  }
  if (isMacAppDataPath(repoPath ?? repo.path)) {
    return null
  }
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  const cacheKey = prCacheKey(
    repoPath ?? repo.path,
    repo.id,
    branch,
    state.settings,
    repo.connectionId
  )
  const cachedPR = state.prCache[cacheKey]?.data ?? null
  const hostedReviewFallbackPRNumber = githubHostedReviewFallbackPRNumber(
    state,
    repoPath ?? repo.path,
    repo.id,
    branch,
    repo.connectionId
  )
  const cachedFallbackPRNumber = cachedPR?.number ?? null
  const fallbackPRNumber =
    worktree.linkedPR == null ? (cachedFallbackPRNumber ?? hostedReviewFallbackPRNumber) : null
  const fallbackPRSource: GitHubPRFallbackSource | null =
    worktree.linkedPR != null || fallbackPRNumber == null
      ? null
      : cachedFallbackPRNumber != null
        ? 'pr-cache'
        : 'hosted-review'
  const sshStatus = repo.connectionId
    ? state.sshConnectionStates.get(repo.connectionId)?.status
    : null
  return {
    repoId: repo.id,
    repoPath: repoPath ?? repo.path,
    repoKind: repo.kind ?? 'git',
    branch,
    cacheKey,
    worktreeId: worktree.id,
    // Why: persisted linked PR metadata is exact, while PR cache numbers are
    // only fallback hints after branch lookup misses.
    linkedPRNumber: worktree.linkedPR ?? null,
    fallbackPRNumber,
    fallbackPRSource,
    isBare: worktree.isBare,
    isArchived: worktree.isArchived,
    connectionId: repo.connectionId ?? null,
    connectionState: repo.connectionId
      ? sshStatus === 'connected'
        ? 'connected'
        : 'disconnected'
      : 'unknown',
    cachedFetchedAt: state.prCache[cacheKey]?.fetchedAt ?? null,
    cachedHasPR: cachedPR ? true : state.prCache[cacheKey] ? false : null,
    cachedPRState: cachedPR?.state ?? null,
    cachedChecksStatus: cachedPR?.checksStatus ?? null,
    cachedMergeable: cachedPR?.mergeable ?? null,
    cachedMergeStateStatus: cachedPR?.mergeStateStatus ?? null
  }
}

function githubHostedReviewFallbackPRNumber(
  state: AppState,
  repoPath: string,
  repoId: string | undefined,
  branch: string,
  connectionId?: string | null
): number | null {
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    repoPath,
    branch,
    state.settings,
    repoId,
    connectionId
  )
  const hostedReview = state.hostedReviewCache[hostedReviewCacheKey]?.data
  return hostedReview?.provider === 'github' ? hostedReview.number : null
}

function shouldClearHostedReviewForNoGitHubPR(
  entry: AppState['hostedReviewCache'][string] | undefined
): boolean {
  // Why: a GitHub-only miss should not create or refresh provider-neutral
  // branch misses that suppress discovery for GitLab/other hosted reviews.
  if (!entry) {
    return false
  }
  if (entry.data?.provider === 'github') {
    return true
  }
  return entry.data === null && isGitHubLinkedReviewHintKey(entry.linkedReviewHintKey)
}

function isGitHubLinkedReviewHintKey(hintKey: string | undefined): boolean {
  return hintKey?.split('|').some((key) => key.startsWith('github:')) ?? false
}

function prLookupHintKey(linkedPRNumber: number | null, fallbackPRNumber: number | null): string {
  if (linkedPRNumber !== null) {
    return `linked:${linkedPRNumber}`
  }
  return fallbackPRNumber !== null ? `fallback:${fallbackPRNumber}` : ''
}

function linkedReviewHintKeyForNoGitHubPR(
  entry: AppState['hostedReviewCache'][string] | undefined
): string | undefined {
  if (entry?.data?.provider === 'github') {
    return isGitHubLinkedReviewHintKey(entry.linkedReviewHintKey)
      ? entry.linkedReviewHintKey
      : linkedReviewHintKey({ linkedGitHubPR: entry.data.number })
  }
  return entry?.linkedReviewHintKey
}

function hasNewerHostedReviewCacheEntry(
  cache: AppState['hostedReviewCache'],
  cacheKey: string,
  requestStartedAt: number,
  requestStartedEntry: AppState['hostedReviewCache'][string] | undefined
): boolean {
  const entry = cache[cacheKey]
  return (
    entry !== undefined &&
    (entry.fetchedAt > requestStartedAt ||
      (entry.fetchedAt === requestStartedAt && entry !== requestStartedEntry))
  )
}

function syncHostedReviewCacheFromGitHubPRResult(args: {
  cache: AppState['hostedReviewCache']
  repoPath: string
  branch: string
  settings: AppState['settings']
  repoId?: string
  connectionId?: string | null
  pr: PRInfo | null
  fetchedAt: number
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
  requestStartedAt?: number
  requestStartedEntry?: AppState['hostedReviewCache'][string]
}): { cache: AppState['hostedReviewCache']; accepted: boolean } {
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId
  )
  if (
    args.requestStartedAt !== undefined &&
    hasNewerHostedReviewCacheEntry(
      args.cache,
      hostedReviewCacheKey,
      args.requestStartedAt,
      args.requestStartedEntry
    )
  ) {
    return { cache: args.cache, accepted: false }
  }
  const hostedReviewEntry = args.cache[hostedReviewCacheKey]
  if (
    args.requestStartedAt === undefined &&
    hostedReviewEntry !== undefined &&
    hostedReviewEntry.fetchedAt >= args.fetchedAt
  ) {
    return { cache: args.cache, accepted: false }
  }
  if (args.pr && hostedReviewEntry?.data && hostedReviewEntry.data.provider !== 'github') {
    return { cache: args.cache, accepted: false }
  }
  if (
    !args.pr &&
    args.linkedPRNumber == null &&
    args.fallbackPRNumber != null &&
    args.fallbackPRSource !== 'hosted-review' &&
    hostedReviewEntry?.data?.provider === 'github' &&
    hostedReviewEntry.data.number === args.fallbackPRNumber
  ) {
    return { cache: args.cache, accepted: false }
  }
  if (!args.pr && !shouldClearHostedReviewForNoGitHubPR(hostedReviewEntry)) {
    return { cache: args.cache, accepted: hostedReviewEntry?.data == null }
  }
  return {
    cache: {
      ...args.cache,
      [hostedReviewCacheKey]: {
        data: args.pr ? hostedReviewInfoFromGitHubPRInfo(args.pr) : null,
        fetchedAt: args.fetchedAt,
        linkedReviewHintKey: args.pr
          ? linkedReviewHintKey({ linkedGitHubPR: args.pr.number })
          : linkedReviewHintKeyForNoGitHubPR(hostedReviewEntry)
      }
    },
    accepted: true
  }
}

function shouldWritePRCacheForHostedReviewSync(args: {
  hostedReviewSyncAccepted: boolean
  hostedReviewEntry: AppState['hostedReviewCache'][string] | undefined
  pr: PRInfo | null
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
}): boolean {
  // Why: PR-status grouping reads prCache while cards read hostedReviewCache.
  // If a GitHub PR result was rejected for the card, don't let grouping drift.
  if (args.hostedReviewSyncAccepted) {
    return true
  }
  const exactPRNumber = args.linkedPRNumber ?? args.fallbackPRNumber ?? null
  return (
    exactPRNumber !== null &&
    args.pr?.number === exactPRNumber &&
    args.hostedReviewEntry?.data?.provider === 'github' &&
    args.hostedReviewEntry.data.number === exactPRNumber
  )
}

function shouldPreserveExistingPRForFallbackMiss(args: {
  currentPR: PRInfo | null | undefined
  nextPR: PRInfo | null
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
}): boolean {
  // Why: fallback PR numbers come from already-visible cache, not durable
  // worktree metadata. A branch/fallback miss is weaker than the current exact
  // PR context, except when the fallback is the hosted-review entry being
  // refreshed; that entry must not protect itself from exact misses.
  return (
    args.nextPR === null &&
    args.linkedPRNumber == null &&
    args.fallbackPRNumber != null &&
    args.fallbackPRSource !== 'hosted-review' &&
    args.currentPR?.number === args.fallbackPRNumber
  )
}

function applyPRCacheResult(
  cache: AppState['prCache'],
  cacheKey: string,
  pr: PRInfo | null,
  fetchedAt: number,
  accepted: boolean,
  preserveExisting: boolean
): AppState['prCache'] {
  if (preserveExisting) {
    return cache
  }
  if (accepted) {
    return withBoundedCacheEntry(cache, cacheKey, { data: pr, fetchedAt })
  }
  if (!cache[cacheKey]) {
    return cache
  }
  const next = { ...cache }
  delete next[cacheKey]
  return next
}

function prRefreshStartedEntryKey(sequence: number, cacheKey: string): string {
  return `${sequence}::${cacheKey}`
}

function deletePRRefreshStartedEntry(sequence: number | undefined, cacheKey: string): void {
  if (sequence !== undefined && sequence > 0) {
    prRefreshStartedHostedReviewEntries.delete(prRefreshStartedEntryKey(sequence, cacheKey))
  }
}

function setPRRefreshStartedHostedReviewEntry(
  key: string,
  entry: AppState['hostedReviewCache'][string] | undefined
): void {
  if (entry === undefined) {
    prRefreshStartedHostedReviewEntries.delete(key)
    return
  }
  prRefreshStartedHostedReviewEntries.delete(key)
  prRefreshStartedHostedReviewEntries.set(key, entry)
  while (prRefreshStartedHostedReviewEntries.size > PR_REFRESH_STARTED_HOSTED_REVIEW_ENTRY_MAX) {
    const oldest = prRefreshStartedHostedReviewEntries.keys().next()
    if (oldest.done) {
      return
    }
    prRefreshStartedHostedReviewEntries.delete(oldest.value)
  }
}

function deletePRRefreshStartedEntriesForEvent(
  event: GitHubPRRefreshEvent,
  sequences: AppState['prRefreshSequences']
): void {
  for (const alias of event.aliases) {
    deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
    deletePRRefreshStartedEntry(sequences[alias.cacheKey], alias.cacheKey)
  }
}

function setGitHubPRResultCaches(
  state: AppState,
  args: {
    prCacheKey: string
    repoPath: string
    branch: string
    settings: AppState['settings']
    repoId?: string
    connectionId?: string | null
    pr: PRInfo | null
    fetchedAt: number
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    fallbackPRSource?: GitHubPRFallbackSource | null
    requestStartedAt?: number
    requestStartedEntry?: AppState['hostedReviewCache'][string]
  }
): Partial<AppState> {
  const hostedReviewSync = syncHostedReviewCacheFromGitHubPRResult({
    cache: state.hostedReviewCache,
    repoPath: args.repoPath,
    branch: args.branch,
    settings: args.settings,
    repoId: args.repoId,
    connectionId: args.connectionId,
    pr: args.pr,
    fetchedAt: args.fetchedAt,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource,
    requestStartedAt: args.requestStartedAt,
    requestStartedEntry: args.requestStartedEntry
  })
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId
  )
  return {
    prCache: applyPRCacheResult(
      state.prCache,
      args.prCacheKey,
      args.pr,
      args.fetchedAt,
      shouldWritePRCacheForHostedReviewSync({
        hostedReviewSyncAccepted: hostedReviewSync.accepted,
        hostedReviewEntry: state.hostedReviewCache[hostedReviewCacheKey],
        pr: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber
      }),
      shouldPreserveExistingPRForFallbackMiss({
        currentPR: state.prCache[args.prCacheKey]?.data,
        nextPR: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber,
        fallbackPRSource: args.fallbackPRSource
      })
    ),
    ...(hostedReviewSync.cache === state.hostedReviewCache
      ? {}
      : { hostedReviewCache: hostedReviewSync.cache })
  }
}

function applyGitHubPRResultToCaches(args: {
  prCache: AppState['prCache']
  hostedReviewCache: AppState['hostedReviewCache']
  prCacheKey: string
  repoPath: string
  branch: string
  settings: AppState['settings']
  repoId?: string
  connectionId?: string | null
  pr: PRInfo | null
  fetchedAt: number
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
  requestStartedAt?: number
  requestStartedEntry?: AppState['hostedReviewCache'][string]
}): {
  prCache: AppState['prCache']
  hostedReviewCache: AppState['hostedReviewCache']
} {
  const hostedReviewSync = syncHostedReviewCacheFromGitHubPRResult({
    cache: args.hostedReviewCache,
    repoPath: args.repoPath,
    branch: args.branch,
    settings: args.settings,
    repoId: args.repoId,
    connectionId: args.connectionId,
    pr: args.pr,
    fetchedAt: args.fetchedAt,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource,
    requestStartedAt: args.requestStartedAt,
    requestStartedEntry: args.requestStartedEntry
  })
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId
  )
  return {
    prCache: applyPRCacheResult(
      args.prCache,
      args.prCacheKey,
      args.pr,
      args.fetchedAt,
      shouldWritePRCacheForHostedReviewSync({
        hostedReviewSyncAccepted: hostedReviewSync.accepted,
        hostedReviewEntry: args.hostedReviewCache[hostedReviewCacheKey],
        pr: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber
      }),
      shouldPreserveExistingPRForFallbackMiss({
        currentPR: args.prCache[args.prCacheKey]?.data,
        nextPR: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber,
        fallbackPRSource: args.fallbackPRSource
      })
    ),
    hostedReviewCache: hostedReviewSync.cache
  }
}

/**
 * Evict the oldest entries from a cache record when it exceeds the max size.
 * Returns a pruned copy, or the original reference if no eviction was needed.
 */
function evictStaleEntries<T extends { fetchedAt: number }>(
  cache: Record<string, T>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, T> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys
    .map((k) => ({ key: k, fetchedAt: cache[k].fetchedAt }))
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
  const keep = new Set(sorted.slice(0, maxEntries).map((e) => e.key))
  const pruned: Record<string, T> = {}
  for (const k of keep) {
    pruned[k] = cache[k]
  }
  return pruned
}

function withBoundedCacheEntry<T extends { fetchedAt: number }>(
  cache: Record<string, T>,
  key: string,
  entry: T
): Record<string, T> {
  return evictStaleEntries({ ...cache, [key]: entry })
}

function shouldRefreshIssueDecorations(state: AppState): boolean {
  return (state.worktreeCardProperties ?? []).includes('issue')
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSaveCache(state: AppState): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.api.cache.setGitHub({
      cache: {
        pr: state.prCache,
        issue: state.issueCache
      }
    })
  }, 1000) // Save at most once per second
}

export type GitHubSlice = {
  prCache: Record<string, CacheEntry<PRInfo>>
  issueCache: Record<string, CacheEntry<IssueInfo>>
  checksCache: Record<string, CacheEntry<PRCheckDetail[]>>
  commentsCache: Record<string, CacheEntry<PRComment[]>>
  prRefreshSequences: Record<string, number>
  prRefreshStates: Record<string, PRRefreshState>
  prVisibleRefreshGeneration: number
  // Why: keyed by repoId + limit + query so remote repos with the same path on
  // different SSH targets do not share issue/PR results.
  // from cache instantly on mount (and on hover-prefetch from sidebar buttons)
  // while a background refresh keeps the list fresh.
  workItemsCache: Record<string, CacheEntry<GitHubWorkItem[]>>
  fetchPRForBranch: (
    repoPath: string,
    branch: string,
    options?: RepoScopedFetchOptions & {
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
  /**
   * Why: returns cached work items immediately (null if none) and fires a
   * background refresh when stale. Callers can render the cached list while
   * the SWR revalidate hydrates the latest.
   */
  getCachedWorkItems: (repoId: string, limit: number, query: string) => GitHubWorkItem[] | null
  /**
   * Why: the Tasks view header reads sources from the cache to render the
   * "Issues from owner/repo" indicator, and the Tasks empty/partial banner
   * reads `error` here to show the retry affordance. Returning a thin view of
   * the cache entry (never the items) keeps this a cheap selector the
   * component can subscribe to without dragging the whole work-item array
   * through the equality check.
   */
  getWorkItemsSourcesAndError: (
    repoId: string,
    limit: number,
    query: string
  ) => { sources: WorkItemsCacheSources | null; error: WorkItemsCacheError | null }
  /**
   * Why: the dialog renders the "Issue from owner/repo" chip for a single work
   * item but may be opened before the Tasks view has populated the primary
   * `(repoPath, PER_REPO_FETCH_LIMIT, '')` cache entry — e.g. when the user
   * searches for an issue by query. Falls back to scanning `workItemsCache`
   * for any entry keyed by `${repoPath}::` that carries resolved sources,
   * returning that entry's `sources` directly. Sources are repo-level
   * (query-independent), so any sibling entry is safe to reuse.
   *
   * Returning a single stable reference means the dialog can subscribe to just
   * this selector instead of the whole `workItemsCache`, so unrelated cache
   * writes don't force a re-render. Cache entries are fully replaced (not
   * mutated) on every write, so reference equality is preserved between
   * unchanged entries.
   */
  getWorkItemsAnySourcesForRepo: (repoId: string, limit: number) => WorkItemsCacheSources | null
  fetchWorkItems: (
    repoId: string,
    repoPath: string,
    limit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<GitHubWorkItem[]>
  /**
   * Why: fan out a single work-item query across multiple repos. Partial
   * failures don't reject — a repo that both fails to fetch *and* has no
   * cached fallback contributes nothing and increments `failedCount`, which
   * the caller surfaces as a "N of M projects failed to load" banner. A repo
   * served from stale cache on rejection is NOT counted as failed — matching
   * the single-repo behavior of quietly serving stale data.
   */
  fetchWorkItemsAcrossRepos: (
    repos: { repoId: string; path: string }[],
    perRepoLimit: number,
    displayLimit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<{ items: GitHubWorkItem[]; failedCount: number }>
  /**
   * Fetch the next page of work items using a date cursor. Does not cache —
   * pagination pages are ephemeral and managed by TaskPage state.
   */
  fetchWorkItemsNextPage: (
    repos: { repoId: string; path: string }[],
    perRepoLimit: number,
    displayLimit: number,
    query: string,
    before: string
  ) => Promise<{ items: GitHubWorkItem[]; failedCount: number }>
  /**
   * Count total work items across repos using GitHub's search API.
   * Returns the sum of per-repo counts for the given query.
   */
  countWorkItemsAcrossRepos: (
    repos: { repoId: string; path: string }[],
    query: string
  ) => Promise<number>
  /**
   * Fire-and-forget prefetch used by UI entry points (hover/focus of the
   * "new workspace" buttons) to warm the cache before the page mounts.
   */
  prefetchWorkItems: (repoId: string, repoPath: string, limit?: number, query?: string) => void
  patchWorkItem: (itemId: string, patch: Partial<GitHubWorkItem>, repoId?: string | null) => void
  /**
   * Monotonic counter bumped whenever a repo's issue-source preference is
   * flipped. Subscribers (TaskPage's fetch effect) include this in their
   * dependency array to force a re-fetch after preference changes — the
   * work-items cache eviction alone isn't enough because the effect keys on
   * `selectedRepos`/`appliedTaskSearch`/`taskRefreshNonce` and wouldn't
   * otherwise notice the cache went empty.
   */
  workItemsInvalidationNonce: number
  /**
   * Persist a per-repo issue-source preference, update the local Repo record
   * for reactive UI, and invalidate all cached work-items entries that key
   * off this repo's identity so the Tasks list re-fetches against the new source.
   *
   * Why invalidate all `${repoId}::*` keys and not only the primary entry:
   * preferences flip the issue source for every list query (query-less +
   * user-entered queries alike). Surgical eviction of the primary key alone
   * would leave stale results in alternate-query cache lines.
   */
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
  /** Optimistic, IPC-free patcher for a single `projectViewCache` row's
   *  `content`. Used by GitHubItemDialog when `projectOrigin` is set so the
   *  Project table re-renders immediately after dialog edits — `patchWorkItem`
   *  alone only walks `workItemsCache` and would leave the Project view stale
   *  until the next refresh. The actual write is dispatched separately via
   *  the slug-addressed update IPCs. */
  patchProjectRowContent: (cacheKey: string, rowId: string, patch: ProjectRowContentPatch) => void
}

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (set, get) => ({
  prCache: {},
  issueCache: {},
  checksCache: {},
  commentsCache: {},
  prRefreshSequences: {},
  prRefreshStates: {},
  prVisibleRefreshGeneration: 0,
  workItemsCache: {},
  workItemsInvalidationNonce: 0,
  projectViewCache: {},

  fetchProjectViewTable: async (args, options) => {
    const requestKey = projectViewRequestKey(args)

    // Fast path: when the caller supplies `viewId`, we already know the
    // resolved cache key and can serve a fresh entry directly.
    const maybeKnownKey = args.viewId
      ? projectViewCacheKey(
          args.ownerType,
          args.owner,
          args.projectNumber,
          args.viewId,
          args.queryOverride
        )
      : null
    if (!options?.force && maybeKnownKey) {
      const cached = get().projectViewCache[maybeKnownKey]
      if (cached?.data && Date.now() - cached.fetchedAt < WORK_ITEMS_CACHE_TTL) {
        return { ok: true, data: cached.data }
      }
    }

    const existing = inflightProjectViewRequests.get(requestKey)
    if (existing) {
      // Why: mirror fetchWorkItems force-refresh semantics — a forcing caller
      // must not silently dedupe to a non-forcing in-flight request; wait for
      // that to settle (result discarded) and then issue a fresh forced call.
      if (options?.force && !existing.force) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

    const request = (async (): Promise<GetProjectViewTableResult> => {
      await acquireWorkItemSlot()
      try {
        const target = getActiveRuntimeTarget(get().settings)
        const envelope =
          target.kind === 'environment'
            ? await callRuntimeRpc<GetProjectViewTableResult>(
                target,
                'github.project.viewTable',
                args,
                { timeoutMs: 60_000 }
              )
            : await window.api.gh.getProjectViewTable(args)
        if (envelope.ok) {
          const table = envelope.data
          const key = projectViewCacheKey(
            table.project.ownerType,
            table.project.owner,
            table.project.number,
            table.selectedView.id,
            args.queryOverride
          )
          set((s) => ({
            projectViewCache: withBoundedCacheEntry(s.projectViewCache, key, {
              data: table,
              fetchedAt: Date.now()
            })
          }))
        } else if (maybeKnownKey) {
          // Only stamp the error onto the cache when we have a resolved key
          // (i.e. caller supplied viewId). Otherwise we have nowhere to write
          // it — the renderer classifies the error directly from the envelope.
          set((s) => ({
            projectViewCache: withBoundedCacheEntry(s.projectViewCache, maybeKnownKey, {
              data: s.projectViewCache[maybeKnownKey]?.data ?? null,
              fetchedAt: Date.now(),
              error: envelope.error
            })
          }))
        }
        return envelope
      } catch (err) {
        // Why: IPC boundary must not throw across the promise — wrap any
        // unexpected error in the classified envelope so the renderer has
        // a single shape to render.
        console.error('Failed to fetch GitHub project view:', err)
        return {
          ok: false,
          error: {
            type: 'unknown',
            message: err instanceof Error ? err.message : 'Failed to fetch project view'
          }
        }
      } finally {
        releaseWorkItemSlot()
        inflightProjectViewRequests.delete(requestKey)
      }
    })()

    inflightProjectViewRequests.set(requestKey, {
      promise: request,
      force: Boolean(options?.force)
    })
    return request
  },

  updateProjectFieldValue: async (cacheKey, rowId, fieldId, value) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    // Optimistic patch: build a field value matching the mutation shape.
    const nextField = optimisticFieldValueFromMutation(table, fieldId, value)
    const optimisticFieldValues = { ...previousRow.fieldValuesByFieldId }
    if (nextField) {
      optimisticFieldValues[fieldId] = nextField
    }
    const optimisticRow: GitHubProjectRow = {
      ...previousRow,
      fieldValuesByFieldId: optimisticFieldValues
    }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    const target = getActiveRuntimeTarget(get().settings)
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.updateItemField',
            {
              projectId: table.project.id,
              itemId: rowId,
              fieldId,
              value
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateProjectItemField({
            projectId: table.project.id,
            itemId: rowId,
            fieldId,
            value
          })
    if (!result.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return result
  },

  clearProjectFieldValue: async (cacheKey, rowId, fieldId) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    const optimisticFieldValues = { ...previousRow.fieldValuesByFieldId }
    delete optimisticFieldValues[fieldId]
    const optimisticRow: GitHubProjectRow = {
      ...previousRow,
      fieldValuesByFieldId: optimisticFieldValues
    }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    const target = getActiveRuntimeTarget(get().settings)
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.clearItemField',
            {
              projectId: table.project.id,
              itemId: rowId,
              fieldId
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.clearProjectItemField({
            projectId: table.project.id,
            itemId: rowId,
            fieldId
          })
    if (!result.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return result
  },

  patchProjectIssueOrPr: async (cacheKey, rowId, updates) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    const { owner, repo, number } = parseSlugAndNumber(previousRow) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate(
            'auto.store.slices.github.87020f6605',
            'Row has no owner/repo/number — cannot patch underlying item'
          )
        }
      }
    }
    // Optimistic content patch.
    const nextContent = { ...previousRow.content }
    if (updates.title !== undefined) {
      nextContent.title = updates.title
    }
    if (updates.body !== undefined) {
      nextContent.body = updates.body
    }
    if (updates.addLabels || updates.removeLabels) {
      const next = new Map(nextContent.labels.map((l) => [l.name, l]))
      for (const name of updates.addLabels ?? []) {
        if (!next.has(name)) {
          next.set(name, { name, color: '808080' })
        }
      }
      for (const name of updates.removeLabels ?? []) {
        next.delete(name)
      }
      nextContent.labels = Array.from(next.values())
    }
    if (updates.addAssignees || updates.removeAssignees) {
      const next = new Map(nextContent.assignees.map((u) => [u.login, u]))
      for (const login of updates.addAssignees ?? []) {
        if (!next.has(login)) {
          next.set(login, { login, name: null, avatarUrl: null })
        }
      }
      for (const login of updates.removeAssignees ?? []) {
        next.delete(login)
      }
      nextContent.assignees = Array.from(next.values())
    }
    const optimisticRow: GitHubProjectRow = { ...previousRow, content: nextContent }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    // Why: PRs and issues both accept label/assignee edits through the issue
    // endpoint — GitHub PRs are issues for labels/assignees. Title/body for
    // PRs goes through updatePullRequestBySlug; for issues through
    // updateIssueBySlug. We dispatch both as needed.
    let envelope: GitHubProjectMutationResult = { ok: true }
    const target = getActiveRuntimeTarget(get().settings)
    if (
      previousRow.itemType === 'PULL_REQUEST' &&
      (updates.title !== undefined || updates.body !== undefined)
    ) {
      const args = {
        owner,
        repo,
        number,
        updates: {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.body !== undefined ? { body: updates.body } : {})
        }
      }
      const prRes =
        target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.updatePullRequestBySlug',
              args,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updatePullRequestBySlug(args)
      if (!prRes.ok) {
        envelope = prRes
      }
    }
    if (
      envelope.ok &&
      (updates.addLabels?.length ||
        updates.removeLabels?.length ||
        updates.addAssignees?.length ||
        updates.removeAssignees?.length ||
        (previousRow.itemType === 'ISSUE' &&
          (updates.title !== undefined || updates.body !== undefined)))
    ) {
      const args = {
        owner,
        repo,
        number,
        updates: {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.body !== undefined ? { body: updates.body } : {}),
          ...(updates.addLabels ? { addLabels: updates.addLabels } : {}),
          ...(updates.removeLabels ? { removeLabels: updates.removeLabels } : {}),
          ...(updates.addAssignees ? { addAssignees: updates.addAssignees } : {}),
          ...(updates.removeAssignees ? { removeAssignees: updates.removeAssignees } : {})
        }
      }
      const issueRes =
        target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.updateIssueBySlug',
              args,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updateIssueBySlug(args)
      if (!issueRes.ok) {
        envelope = issueRes
      }
    }
    if (!envelope.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return envelope
  },

  patchProjectRowIssueType: async (cacheKey, rowId, issueType) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const row = table.rows.find((r) => r.id === rowId)
    if (!row) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    if (row.itemType !== 'ISSUE') {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate(
            'auto.store.slices.github.83f9b126ad',
            'Issue Type can only be set on Issues.'
          )
        }
      }
    }
    const { owner, repo, number } = parseSlugAndNumber(row) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate('auto.store.slices.github.683a21264b', 'Row has no owner/repo/number.')
        }
      }
    }
    const previousRow = row
    const optimistic: GitHubProjectRow = {
      ...previousRow,
      content: { ...previousRow.content, issueType }
    }
    applyRowPatch(set, cacheKey, rowId, optimistic)
    const target = getActiveRuntimeTarget(get().settings)
    const args = {
      owner,
      repo,
      number,
      issueTypeId: issueType?.id ?? null
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.updateIssueTypeBySlug',
            args,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateIssueTypeBySlug(args)
    if (!res.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return res
  },

  patchProjectRowContent: (cacheKey, rowId, patch) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return
    }
    const previousRow = table.rows.find((r) => r.id === rowId)
    if (!previousRow) {
      return
    }
    const nextContent = { ...previousRow.content }
    if (patch.title !== undefined) {
      nextContent.title = patch.title
    }
    if (patch.body !== undefined) {
      nextContent.body = patch.body
    }
    if (patch.state !== undefined) {
      // Why: ProjectV2 row.state mirrors GitHub's UPPERCASE state enum
      // ('OPEN' | 'CLOSED' | 'MERGED'). The dialog tracks lowercase
      // ('open' | 'closed') matching `GitHubWorkItem['state']`. Translate
      // here so the optimistic patch matches the canonical row shape and
      // the next authoritative fetch overwrites cleanly.
      nextContent.state = patch.state.toUpperCase()
    }
    if (patch.labels !== undefined) {
      const existingByName = new Map(previousRow.content.labels.map((l) => [l.name, l]))
      nextContent.labels = patch.labels.map(
        (name) => existingByName.get(name) ?? { name, color: '808080' }
      )
    }
    if (patch.assignees !== undefined) {
      const existingByLogin = new Map(previousRow.content.assignees.map((u) => [u.login, u]))
      nextContent.assignees = patch.assignees.map(
        (login) => existingByLogin.get(login) ?? { login, name: null, avatarUrl: null }
      )
    }
    const nextRow: GitHubProjectRow = { ...previousRow, content: nextContent }
    applyRowPatch(set, cacheKey, rowId, nextRow)
  },

  getCachedWorkItems: (repoId, limit, query) => {
    const key = workItemsCacheKey(repoId, limit, query)
    return get().workItemsCache[key]?.data ?? null
  },

  getWorkItemsSourcesAndError: (repoId, limit, query) => {
    const key = workItemsCacheKey(repoId, limit, query)
    const entry = get().workItemsCache[key]
    return {
      sources: entry?.sources ?? null,
      error: entry?.error ?? null
    }
  },

  getWorkItemsAnySourcesForRepo: (repoId, limit) => {
    const cache = get().workItemsCache
    const primaryKey = workItemsCacheKey(repoId, limit, '')
    const primary = cache[primaryKey]?.sources
    if (primary) {
      return primary
    }
    const prefix = `${repoId}::`
    for (const [key, entry] of Object.entries(cache)) {
      if (key.startsWith(prefix) && entry.sources) {
        return entry.sources
      }
    }
    return null
  },

  fetchWorkItems: async (repoId, repoPath, limit, query, options): Promise<GitHubWorkItem[]> => {
    const key = workItemsCacheKey(repoId, limit, query)
    const cached = get().workItemsCache[key]
    if (!options?.force && isFresh(cached, WORK_ITEMS_CACHE_TTL)) {
      return cached.data ?? []
    }

    const requestState = get()
    const requestSettings = requestState.settings
    const requestRuntimeEnvironmentId = activeRuntimeEnvironmentId(requestSettings)
    const requestContext = getGitHubWorkItemRequestContext(
      requestState,
      requestSettings,
      repoId,
      repoPath
    )
    const inflightKey = workItemsInflightRequestKey(key, requestContext.target)
    const existing = inflightWorkItemsRequests.get(inflightKey)
    if (existing) {
      // Why: a user-initiated refresh (force=true) must not silently dedupe to
      // a less-fresh fetch already in flight. noCache=true is stricter than a
      // cacheable forced landing probe because it must bypass gh api's cache too.
      if ((options?.force && !existing.force) || (options?.noCache && !existing.noCache)) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

    const request = (async () => {
      await acquireWorkItemSlot()
      try {
        const envelope = await listGitHubWorkItemsForRepo(requestContext, {
          limit,
          query: query || undefined,
          ...(options?.noCache ? { noCache: true } : {})
        })
        // Why: stamp repoId at the renderer fetch boundary so every downstream
        // consumer (cross-repo merge, row rendering, drawer) can rely on the
        // field being present. Main doesn't know Orca's Repo.id.
        const items: GitHubWorkItem[] = envelope.items.map((item) => ({ ...item, repoId }))
        // Why: only surface the issues-side error in the cache entry. The
        // parent design doc §2 scopes feature 1 to the new class of silent
        // wrongness introduced by the issue-source split in #1076; PR-side
        // failures existed before and are out of scope for this banner.
        const issuesError = envelope.errors?.issues
        // Why: if the main process resolved `errors.issues` but not `sources.issues`,
        // the renderer has no slug to render in the banner copy, so the error is
        // dropped from the cache entry. Log it so this rare case is at least visible
        // in devtools rather than disappearing silently.
        if (issuesError && !envelope.sources.issues) {
          console.warn(
            '[workItems] dropping issues-side error with no resolved source:',
            issuesError
          )
        }
        const errorForCache: WorkItemsCacheError | undefined =
          issuesError && envelope.sources.issues
            ? { ...issuesError, source: envelope.sources.issues }
            : undefined
        // Why: runtime switches reset server-scoped caches; queued old-runtime
        // responses can still satisfy callers but must not revive reset entries.
        if (activeRuntimeEnvironmentId(get().settings) !== requestRuntimeEnvironmentId) {
          return items
        }
        set((s) => ({
          workItemsCache: withBoundedCacheEntry(s.workItemsCache, key, {
            data: items,
            fetchedAt: Date.now(),
            sources: envelope.sources,
            ...(errorForCache ? { error: errorForCache } : {}),
            ...(envelope.issueSourceFellBack ? { issueSourceFellBack: true } : {})
          })
        }))
        return items
      } catch (err) {
        // Why: surface the error to the caller; keep stale cache entry so the
        // UI can continue to render something useful while the user retries.
        if (!isGitHubWorkItemsSshRemoteRequiredError(err)) {
          console.error('Failed to fetch GitHub work items:', err)
        }
        throw err
      } finally {
        releaseWorkItemSlot()
        inflightWorkItemsRequests.delete(inflightKey)
      }
    })()

    inflightWorkItemsRequests.set(inflightKey, {
      promise: request,
      force: Boolean(options?.force),
      noCache: Boolean(options?.noCache)
    })
    return request
  },

  fetchWorkItemsAcrossRepos: async (repos, perRepoLimit, displayLimit, query, options) => {
    const state = get()
    let failedCount = 0
    const perProjectResults = await Promise.all(
      repos.map(async (r) => {
        try {
          return await state.fetchWorkItems(r.repoId, r.path, perRepoLimit, query, options)
        } catch (err) {
          // Why: fall back to any cache entry (stale or not) before declaring
          // this repo failed. Matches single-repo behavior of silently serving
          // stale data on error. A repo is only counted as failed when it has
          // nothing at all to contribute.
          // Why: must use perRepoLimit (not displayLimit) so the cache key
          // matches what fetchWorkItems wrote.
          if (isGitHubWorkItemsSshRemoteRequiredError(err)) {
            return [] as GitHubWorkItem[]
          }
          const key = workItemsCacheKey(r.repoId, perRepoLimit, query)
          const cached = get().workItemsCache[key]?.data
          if (cached) {
            console.warn(`[workItems] ${r.repoId} failed, serving cached:`, err)
            return cached
          }
          console.warn(`[workItems] ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        }
      })
    )
    const merged = sortWorkItemsByUpdatedAt(perProjectResults.flat()).slice(0, displayLimit)
    return { items: merged, failedCount }
  },

  fetchWorkItemsNextPage: async (repos, perRepoLimit, displayLimit, query, before) => {
    let failedCount = 0
    const perProjectResults = await Promise.all(
      repos.map(async (r) => {
        const requestState = get()
        const requestSettings = requestState.settings
        const requestContext = getGitHubWorkItemRequestContext(
          requestState,
          requestSettings,
          r.repoId,
          r.path
        )
        await acquireWorkItemSlot()
        try {
          const envelope = await listGitHubWorkItemsForRepo(requestContext, {
            limit: perRepoLimit,
            query: query || undefined,
            before
          })
          // Why: page-N partial failures don't participate in the cache's per-repo
          // error banner (which is keyed on the initial-fetch cache entry). Log the
          // classified issues-side error so pagination failures are at least
          // observable in logs rather than silently truncating the merged list. A
          // richer surface would require threading per-page errors back to the
          // caller and wiring a transient pagination banner — deferred per parent
          // design doc §6 scope.
          if (envelope.errors?.issues) {
            console.warn(
              `[workItems] next page ${r.repoId} issues-side partial failure:`,
              envelope.errors.issues
            )
          }
          return envelope.items.map((item): GitHubWorkItem => ({ ...item, repoId: r.repoId }))
        } catch (err) {
          if (isGitHubWorkItemsSshRemoteRequiredError(err)) {
            return [] as GitHubWorkItem[]
          }
          console.warn(`[workItems] next page ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        } finally {
          releaseWorkItemSlot()
        }
      })
    )
    const merged = sortWorkItemsByUpdatedAt(perProjectResults.flat()).slice(0, displayLimit)
    return { items: merged, failedCount }
  },

  countWorkItemsAcrossRepos: async (repos, query) => {
    const counts = await Promise.all(
      repos.map(async (r) => {
        try {
          const requestState = get()
          const requestSettings = requestState.settings
          const requestContext = getGitHubWorkItemRequestContext(
            requestState,
            requestSettings,
            r.repoId,
            r.path
          )
          return await countGitHubWorkItemsForRepo(requestContext, { query: query || undefined })
        } catch {
          return 0
        }
      })
    )
    return counts.reduce((sum, c) => sum + c, 0)
  },

  prefetchWorkItems: (repoId, repoPath, limit = PER_REPO_FETCH_LIMIT, query = '') => {
    const key = workItemsCacheKey(repoId, limit, query)
    const cached = get().workItemsCache[key]
    const requestState = get()
    const requestContext = getGitHubWorkItemRequestContext(
      requestState,
      requestState.settings,
      repoId,
      repoPath
    )
    const inflightKey = workItemsInflightRequestKey(key, requestContext.target)
    // Skip when the cache is fresh or a request is already in flight.
    if (isFresh(cached, WORK_ITEMS_CACHE_TTL) || inflightWorkItemsRequests.has(inflightKey)) {
      return
    }
    void get()
      .fetchWorkItems(repoId, repoPath, limit, query)
      .catch(() => {})
  },

  initGitHubCache: async () => {
    try {
      const persisted = await window.api.cache.getGitHub()
      if (persisted) {
        set({
          prCache: evictStaleEntries(persisted.pr || {}),
          issueCache: evictStaleEntries(persisted.issue || {})
        })
      }
    } catch (err) {
      console.error('Failed to load GitHub cache from disk:', err)
    }
  },

  fetchPRForBranch: async (repoPath, branch, options): Promise<PRInfo | null> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = prCacheKey(repoPath, repoId, branch, requestSettings, repo?.connectionId)
    const cached = get().prCache[cacheKey]
    const hostedReviewCacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      requestSettings,
      repoId,
      repo?.connectionId
    )
    // Why: if a prior caller without a linkedPR cached `null` for this branch,
    // the worktree-card lookup (which has a linked PR fallback) would otherwise
    // return null forever. Refetch when the cached miss could now resolve via
    // the linkedPR path.
    const linkedPRNumber = options?.linkedPRNumber ?? null
    const explicitFallbackPRNumber = options?.fallbackPRNumber ?? null
    const hostedReviewFallbackPRNumber = githubHostedReviewFallbackPRNumber(
      get(),
      repoPath,
      repoId,
      branch,
      repo?.connectionId
    )
    const fallbackPRNumber =
      linkedPRNumber == null ? (explicitFallbackPRNumber ?? hostedReviewFallbackPRNumber) : null
    const fallbackPRSource: GitHubPRFallbackSource | null =
      linkedPRNumber != null || fallbackPRNumber == null
        ? null
        : (options?.fallbackPRSource ??
          (explicitFallbackPRNumber != null ? 'explicit' : 'hosted-review'))
    const lookupHintKey = prLookupHintKey(linkedPRNumber, fallbackPRNumber)
    const linkedRefetch =
      cached?.data === null && (linkedPRNumber !== null || fallbackPRNumber !== null)
    if (!options?.force && !linkedRefetch && isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (
      inflightRequest &&
      (!options?.force || inflightRequest.force) &&
      inflightRequest.lookupHintKey === lookupHintKey &&
      !linkedRefetch
    ) {
      return inflightRequest.promise
    }

    const generation = (prRequestGenerations.get(cacheKey) ?? 0) + 1
    const requestStartedAt = Date.now()
    const requestStartedHostedReviewEntry = get().hostedReviewCache[hostedReviewCacheKey]
    prRequestGenerations.set(cacheKey, generation)

    const request = (async () => {
      try {
        const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
        const outcome = runtimeRepo
          ? await callRuntimeRpc<PRInfo | null>(
              runtimeRepo.target,
              'github.prForBranch',
              {
                repo: runtimeRepo.repo.id,
                branch,
                linkedPRNumber,
                ...(fallbackPRNumber !== null ? { fallbackPRNumber } : {})
              },
              { timeoutMs: 30_000 }
            ).then((pr) =>
              pr
                ? ({ kind: 'found', pr, fetchedAt: Date.now() } as const)
                : ({ kind: 'no-pr', fetchedAt: Date.now() } as const)
            )
          : await (async () => {
              const candidate: GitHubPRRefreshCandidate = {
                repoId: repoId ?? '',
                repoPath,
                repoKind: repo?.kind ?? 'git',
                branch,
                cacheKey,
                linkedPRNumber,
                fallbackPRNumber,
                fallbackPRSource,
                connectionId: repo?.connectionId ?? null,
                cachedFetchedAt: cached?.fetchedAt ?? null,
                cachedHasPR: cached?.data ? true : cached ? false : null,
                cachedPRState: cached?.data?.state ?? null,
                cachedChecksStatus: cached?.data?.checksStatus ?? null,
                cachedMergeable: cached?.data?.mergeable ?? null,
                cachedMergeStateStatus: cached?.data?.mergeStateStatus ?? null
              }
              return window.api.gh.refreshPRNow
                ? await window.api.gh.refreshPRNow({ candidate })
                : await window.api.gh
                    .prForBranch({ repoPath, repoId, branch, linkedPRNumber, fallbackPRNumber })
                    .then((pr) =>
                      pr
                        ? ({ kind: 'found', pr, fetchedAt: Date.now() } as const)
                        : ({ kind: 'no-pr', fetchedAt: Date.now() } as const)
                    )
            })()
        const pr: PRInfo | null =
          outcome.kind === 'found' ? outcome.pr : outcome.kind === 'no-pr' ? null : null
        if (outcome.kind === 'upstream-error') {
          return cached?.data ?? null
        }
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) =>
            setGitHubPRResultCaches(s, {
              prCacheKey: cacheKey,
              repoPath,
              branch,
              settings: requestSettings,
              repoId,
              connectionId: repo?.connectionId,
              pr,
              fetchedAt: outcome.fetchedAt,
              linkedPRNumber,
              fallbackPRNumber,
              fallbackPRSource,
              requestStartedAt,
              requestStartedEntry: requestStartedHostedReviewEntry
            })
          )
          debouncedSaveCache(get())
        }
        if (
          shouldPreserveExistingPRForFallbackMiss({
            currentPR: get().prCache[cacheKey]?.data,
            nextPR: pr,
            linkedPRNumber,
            fallbackPRNumber,
            fallbackPRSource
          })
        ) {
          return get().prCache[cacheKey]?.data ?? null
        }
        return pr ?? null
      } catch (err) {
        console.error('Failed to fetch PR:', err)
        return null
      } finally {
        const activeRequest = inflightPRRequests.get(cacheKey)
        if (activeRequest?.generation === generation) {
          inflightPRRequests.delete(cacheKey)
          if (prRequestGenerations.get(cacheKey) === generation) {
            prRequestGenerations.delete(cacheKey)
          }
        }
      }
    })()

    inflightPRRequests.set(cacheKey, {
      promise: request,
      force: Boolean(options?.force),
      generation,
      lookupHintKey
    })
    return request
  },

  fetchIssue: async (repoPath, number, options) => {
    const repoId = options?.repoId ?? get().repos?.find((repo) => repo.path === repoPath)?.id
    const cacheKey = repoScopedCacheKey(repoPath, repoId, String(number))
    const cached = get().issueCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightIssueRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const issue = await window.api.gh.issue({ repoPath, repoId, number })
        set((s) => ({
          issueCache: withBoundedCacheEntry(s.issueCache, cacheKey, {
            data: issue,
            fetchedAt: Date.now()
          })
        }))
        debouncedSaveCache(get())
        return issue
      } catch (err) {
        console.error('Failed to fetch issue:', err)
        set((s) => ({
          issueCache: withBoundedCacheEntry(s.issueCache, cacheKey, {
            data: null,
            fetchedAt: Date.now()
          })
        }))
        debouncedSaveCache(get())
        return null
      } finally {
        inflightIssueRequests.delete(cacheKey)
      }
    })()

    inflightIssueRequests.set(cacheKey, request)
    return request
  },

  fetchPRChecks: async (
    repoPath,
    prNumber,
    branch,
    headSha,
    prRepo,
    options
  ): Promise<PRCheckDetail[]> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = runtimeScopedRepoCacheKey(
      repoPath,
      repoId,
      prChecksCacheSuffix(prNumber, prRepo, headSha),
      requestSettings,
      repo?.connectionId
    )
    const legacyCacheKey = headSha
      ? runtimeScopedRepoCacheKey(
          repoPath,
          repoId,
          prChecksCacheSuffix(prNumber, prRepo),
          requestSettings,
          repo?.connectionId
        )
      : cacheKey
    const inflightKey = cacheKey
    const cached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
    if (
      !options?.force &&
      isFresh(cached, CHECKS_CACHE_TTL) &&
      (!headSha || cached.headSha === headSha)
    ) {
      const cachedChecks = cached.data ?? []
      const prStatusUpdate = syncPRChecksStatus(
        get(),
        repoPath,
        repoId,
        branch,
        cachedChecks,
        cached.headSha,
        prRepo,
        requestSettings,
        repo?.connectionId
      )
      if (prStatusUpdate) {
        set(prStatusUpdate)
        debouncedSaveCache(get())
      }
      return cachedChecks
    }

    const inflightRequest = inflightChecksRequests.get(inflightKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
        const checks = runtimeRepo
          ? await callRuntimeRpc<PRCheckDetail[]>(
              runtimeRepo.target,
              'github.prChecks',
              {
                repo: runtimeRepo.repo.id,
                prNumber,
                headSha,
                prRepo: prRepo ?? null,
                noCache: options?.force
              },
              { timeoutMs: 30_000 }
            )
          : ((await window.api.gh.prChecks({
              repoPath,
              repoId,
              prNumber,
              headSha,
              prRepo: prRepo ?? null,
              noCache: options?.force
            })) as PRCheckDetail[])
        set((s) => {
          const nextState: Partial<AppState> = {
            checksCache: withBoundedCacheEntry(s.checksCache, cacheKey, {
              data: checks,
              fetchedAt: Date.now(),
              headSha
            })
          }

          const prStatusUpdate = syncPRChecksStatus(
            s,
            repoPath,
            repoId,
            branch,
            checks,
            headSha,
            prRepo,
            requestSettings,
            repo?.connectionId
          )
          if (prStatusUpdate?.prCache) {
            nextState.prCache = prStatusUpdate.prCache
          }

          return nextState
        })
        debouncedSaveCache(get())
        return checks
      } catch (err) {
        console.error('Failed to fetch PR checks:', err)
        const latestCached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
        if (latestCached?.data && (!headSha || latestCached.headSha === headSha)) {
          return latestCached.data
        }
        return []
      } finally {
        inflightChecksRequests.delete(inflightKey)
      }
    })()

    inflightChecksRequests.set(inflightKey, request)
    return request
  },

  fetchPRCheckDetails: async (repoPath, args, options): Promise<PRCheckRunDetails | null> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
    return runtimeRepo
      ? await callRuntimeRpc<PRCheckRunDetails | null>(
          runtimeRepo.target,
          'github.prCheckDetails',
          {
            repo: runtimeRepo.repo.id,
            checkRunId: args.checkRunId,
            workflowRunId: args.workflowRunId,
            checkName: args.checkName,
            url: args.url,
            prRepo: args.prRepo ?? null
          },
          { timeoutMs: 30_000 }
        )
      : ((await window.api.gh.prCheckDetails({
          repoPath,
          repoId,
          checkRunId: args.checkRunId,
          workflowRunId: args.workflowRunId,
          checkName: args.checkName,
          url: args.url,
          prRepo: args.prRepo ?? null
        })) as PRCheckRunDetails | null)
  },

  fetchPRComments: async (repoPath, prNumber, options): Promise<PRComment[]> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = runtimeScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId
    )
    const cached = get().commentsCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflightRequest = inflightCommentsRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
        const comments = runtimeRepo
          ? await callRuntimeRpc<PRComment[]>(
              runtimeRepo.target,
              'github.prComments',
              {
                repo: runtimeRepo.repo.id,
                prNumber,
                prRepo: options?.prRepo ?? null,
                noCache: options?.force
              },
              { timeoutMs: 30_000 }
            )
          : ((await window.api.gh.prComments({
              repoPath,
              repoId,
              prNumber,
              prRepo: options?.prRepo ?? null,
              noCache: options?.force
            })) as PRComment[])
        set((s) => ({
          commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
            data: comments,
            fetchedAt: Date.now()
          })
        }))
        return comments
      } catch (err) {
        console.error('Failed to fetch PR comments:', err)
        return get().commentsCache[cacheKey]?.data ?? []
      } finally {
        inflightCommentsRequests.delete(cacheKey)
      }
    })()

    inflightCommentsRequests.set(cacheKey, request)
    return request
  },

  addPRConversationComment: async (repoPath, prNumber, body, options) => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = runtimeScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId
    )
    const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
    let result: GitHubCommentResult
    try {
      result = runtimeRepo
        ? await callRuntimeRpc<GitHubCommentResult>(
            runtimeRepo.target,
            'github.addIssueComment',
            {
              repo: runtimeRepo.repo.id,
              number: prNumber,
              body,
              type: 'pr',
              prRepo: options?.prRepo ?? null
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.addIssueComment({
            repoPath,
            repoId,
            number: prNumber,
            body,
            type: 'pr',
            prRepo: options?.prRepo ?? null
          })
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to post comment.'
      return { ok: false, error }
    }
    if (!hasUsableCommentPayload(result)) {
      return result.ok
        ? {
            ok: false,
            error: translate(
              'auto.store.slices.github.f129c42773',
              'GitHub did not return the new comment.'
            )
          }
        : result
    }
    set((s) => {
      const entry = s.commentsCache[cacheKey]
      return {
        commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
          data: mergePRCommentIntoList(entry?.data, result.comment),
          fetchedAt: Date.now()
        })
      }
    })
    return result
  },

  addPRReviewCommentReply: async (repoPath, prNumber, commentId, body, options) => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = runtimeScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId
    )
    const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
    let result: GitHubCommentResult
    try {
      result = runtimeRepo
        ? await callRuntimeRpc<GitHubCommentResult>(
            runtimeRepo.target,
            'github.addPRReviewCommentReply',
            {
              repo: runtimeRepo.repo.id,
              prNumber,
              commentId,
              body,
              threadId: options?.threadId,
              path: options?.path,
              line: options?.line,
              prRepo: options?.prRepo ?? null
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.addPRReviewCommentReply({
            repoPath,
            repoId,
            prNumber,
            commentId,
            body,
            threadId: options?.threadId,
            path: options?.path,
            line: options?.line,
            prRepo: options?.prRepo ?? null
          })
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to post reply.'
      return { ok: false, error }
    }
    if (!hasUsableCommentPayload(result)) {
      return result.ok
        ? {
            ok: false,
            error: translate(
              'auto.store.slices.github.f129c42773',
              'GitHub did not return the new comment.'
            )
          }
        : result
    }
    const comment: PRComment = {
      ...result.comment,
      threadId: result.comment.threadId ?? options?.threadId,
      path: result.comment.path ?? options?.path,
      line: result.comment.line ?? options?.line
    }
    set((s) => {
      const entry = s.commentsCache[cacheKey]
      return {
        commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
          data: mergePRCommentIntoList(entry?.data, comment),
          fetchedAt: Date.now()
        })
      }
    })
    return { ok: true, comment }
  },

  resolveReviewThread: async (repoPath, prNumber, threadId, resolve, options) => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = get().settings
    const cacheKey = runtimeScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId
    )

    // Optimistic update: toggle isResolved on all comments in this thread immediately
    // so the UI feels instant. Reverts if the API call fails.
    const prev = get().commentsCache[cacheKey]?.data
    if (prev) {
      set((s) => ({
        commentsCache: {
          ...s.commentsCache,
          [cacheKey]: {
            ...s.commentsCache[cacheKey],
            data: prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
          }
        }
      }))
    }

    const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
    let ok = false
    try {
      ok = runtimeRepo
        ? await callRuntimeRpc<boolean>(
            runtimeRepo.target,
            'github.resolveReviewThread',
            { repo: runtimeRepo.repo.id, threadId, resolve },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.resolveReviewThread({ repoPath, repoId, threadId, resolve })
    } catch (err) {
      console.error('Failed to update review thread:', err)
      ok = false
    }
    if (!ok && prev) {
      // Revert optimistic update on failure
      set((s) => ({
        commentsCache: {
          ...s.commentsCache,
          [cacheKey]: { ...s.commentsCache[cacheKey], data: prev }
        }
      }))
    }
    return ok
  },

  enqueueGitHubPRRefresh: (worktreeId, reason, priority = 0) => {
    const state = get()
    const worktree = findWorktreeById(state, worktreeId)
    const candidate = worktree ? buildPRRefreshCandidate(state, worktree) : null
    if (!candidate) {
      return
    }
    if (getRuntimeRepoTarget(state, candidate.repoPath)) {
      void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
        force: bypassesGitHubPRRefreshFreshness(reason),
        repoId: candidate.repoId,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        fallbackPRSource: candidate.fallbackPRSource ?? null
      })
      return
    }
    const enqueue = window.api.gh.enqueuePRRefresh
    if (enqueue) {
      void enqueue({ candidate, reason, priority })
        .then((queued) => {
          if (queued === false) {
            return get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
              force: bypassesGitHubPRRefreshFreshness(reason),
              repoId: candidate.repoId,
              linkedPRNumber: candidate.linkedPRNumber ?? null,
              fallbackPRNumber: candidate.fallbackPRNumber ?? null,
              fallbackPRSource: candidate.fallbackPRSource ?? null
            })
          }
          return null
        })
        .catch((err) => {
          console.warn('Failed to enqueue PR refresh:', err)
        })
    }
  },

  reportVisibleGitHubPRRefreshCandidates: (worktreeIds, generation) => {
    const state = get()
    const candidates = worktreeIds
      .map((id) => {
        const worktree = findWorktreeById(state, id)
        return worktree ? buildPRRefreshCandidate(state, worktree) : null
      })
      .filter((candidate): candidate is GitHubPRRefreshCandidate => candidate !== null)
    if (getActiveRuntimeTarget(state.settings).kind === 'environment') {
      for (const candidate of candidates) {
        void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
          repoId: candidate.repoId,
          linkedPRNumber: candidate.linkedPRNumber ?? null,
          fallbackPRNumber: candidate.fallbackPRNumber ?? null,
          fallbackPRSource: candidate.fallbackPRSource ?? null
        })
      }
      return
    }
    const reportVisible = window.api.gh.reportVisiblePRRefreshCandidates
    if (reportVisible) {
      void reportVisible({ candidates, generation }).catch((err) => {
        console.warn('Failed to report visible PR refresh candidates:', err)
      })
    }
  },

  bumpGitHubPRVisibleRefreshGeneration: () => {
    set((s) => ({ prVisibleRefreshGeneration: s.prVisibleRefreshGeneration + 1 }))
  },

  applyGitHubPRRefreshEvent: (event) => {
    set((s) => {
      // Why: local main-process refresh events are keyed only by repo/branch;
      // applying them while a runtime is active can leak local PR state into SSH.
      if (getActiveRuntimeTarget(s.settings).kind === 'environment') {
        deletePRRefreshStartedEntriesForEvent(event, s.prRefreshSequences)
        return {}
      }
      const nextSequences = { ...s.prRefreshSequences }
      const nextStates = { ...s.prRefreshStates }
      let nextPRCache = s.prCache
      let nextHostedReviewCache = s.hostedReviewCache ?? {}
      let changed = false

      for (const alias of event.aliases) {
        const previousSequence = nextSequences[alias.cacheKey] ?? 0
        if (
          event.outcome ? event.sequence < previousSequence : event.sequence <= previousSequence
        ) {
          if (event.outcome || event.status !== 'in-flight') {
            deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
          }
          continue
        }
        nextSequences[alias.cacheKey] = event.sequence
        changed = true

        if (event.outcome) {
          const startedEntryKey = prRefreshStartedEntryKey(event.sequence, alias.cacheKey)
          const requestStartedEntry = prRefreshStartedHostedReviewEntries.get(startedEntryKey)
          prRefreshStartedHostedReviewEntries.delete(startedEntryKey)
          if (previousSequence !== event.sequence) {
            deletePRRefreshStartedEntry(previousSequence, alias.cacheKey)
          }
          delete nextStates[alias.cacheKey]
          if (event.outcome.kind === 'upstream-error') {
            nextStates[alias.cacheKey] = {
              status: 'error',
              reason: event.reason,
              updatedAt: Date.now(),
              message: event.outcome.message
            }
            continue
          }
          const data =
            event.outcome.kind === 'found'
              ? (() => {
                  const pr = event.outcome.pr
                  const checksCacheKeys = [
                    ...(alias.repoId
                      ? [
                          runtimeScopedRepoCacheKey(
                            alias.repoPath,
                            alias.repoId,
                            prChecksCacheSuffix(pr.number, pr.prRepo),
                            s.settings,
                            alias.connectionId
                          )
                        ]
                      : []),
                    runtimeScopedRepoCacheKey(
                      alias.repoPath,
                      undefined,
                      prChecksCacheSuffix(pr.number, pr.prRepo),
                      s.settings,
                      alias.connectionId
                    ),
                    `${alias.repoPath}::pr-checks::${pr.number}`
                  ]
                  const checksEntry = checksCacheKeys
                    .map((key) => s.checksCache[key])
                    .find((entry) => entry?.data)
                  if (
                    checksEntry?.data &&
                    checksEntry.headSha &&
                    pr.headSha &&
                    checksEntry.headSha === pr.headSha &&
                    event.outcome.fetchedAt - checksEntry.fetchedAt < CHECKS_CACHE_TTL
                  ) {
                    return { ...pr, checksStatus: deriveCheckStatusFromChecks(checksEntry.data) }
                  }
                  return pr
                })()
              : null
          const nextCaches = applyGitHubPRResultToCaches({
            prCache: nextPRCache,
            hostedReviewCache: nextHostedReviewCache,
            prCacheKey: alias.cacheKey,
            repoPath: alias.repoPath,
            branch: alias.branch,
            settings: s.settings,
            repoId: alias.repoId,
            connectionId: alias.connectionId,
            pr: data,
            fetchedAt: event.outcome.fetchedAt,
            linkedPRNumber: alias.linkedPRNumber,
            fallbackPRNumber: alias.fallbackPRNumber,
            fallbackPRSource: alias.fallbackPRSource,
            requestStartedAt: event.requestStartedAt,
            requestStartedEntry
          })
          nextPRCache = nextCaches.prCache
          nextHostedReviewCache = nextCaches.hostedReviewCache
          continue
        }

        if (event.status) {
          if (previousSequence !== event.sequence) {
            deletePRRefreshStartedEntry(previousSequence, alias.cacheKey)
          }
          if (event.status === 'in-flight' && event.requestStartedAt !== undefined) {
            const hostedReviewCacheKey = getHostedReviewCacheKey(
              alias.repoPath,
              alias.branch,
              s.settings,
              alias.repoId,
              alias.connectionId
            )
            setPRRefreshStartedHostedReviewEntry(
              prRefreshStartedEntryKey(event.sequence, alias.cacheKey),
              s.hostedReviewCache[hostedReviewCacheKey]
            )
          } else {
            // Why: rate-limit pauses/skips can follow an in-flight broadcast
            // without an outcome; the cached request-start snapshot is no
            // longer live and would otherwise accumulate per refresh sequence.
            deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
          }
          nextStates[alias.cacheKey] = {
            status: event.status,
            reason: event.reason,
            updatedAt: Date.now(),
            pausedUntil: event.pausedUntil
          }
        }
      }

      return changed
        ? {
            prRefreshSequences: nextSequences,
            prRefreshStates: nextStates,
            prCache: nextPRCache,
            hostedReviewCache: nextHostedReviewCache
          }
        : {}
    })
    if (event.outcome && event.outcome.kind !== 'upstream-error') {
      debouncedSaveCache(get())
    }
  },

  refreshAllGitHub: () => {
    // Invalidate comments cache so it refreshes on next access.
    // Also evict old entries from retained caches to prevent unbounded growth
    // across many repos and branches over a long-running session.
    set((s) => ({
      commentsCache: {},
      prCache: evictStaleEntries(s.prCache),
      issueCache: evictStaleEntries(s.issueCache),
      checksCache: evictStaleEntries(s.checksCache),
      workItemsCache: evictStaleEntries(s.workItemsCache),
      projectViewCache: evictStaleEntries(s.projectViewCache)
    }))

    // Why: prRequestGenerations tracks only live inflight fetches and is
    // cleared when the active request settles. Do not prune it here; deleting
    // a live generation would make the corresponding response look stale.

    // Only re-fetch PR/issue entries that are already stale — skip fresh ones
    const state = get()
    const now = Date.now()
    const stalePRCandidates: { candidate: GitHubPRRefreshCandidate; score: number }[] = []
    const cardProps = state.worktreeCardProperties ?? []
    const shouldRefreshIssues = shouldRefreshIssueDecorations(state)
    const isPRStatusGrouping = state.groupBy === 'pr-status'
    const rightSidebarShowsPR = rightSidebarShowsPullRequestData(state)
    const shouldRefreshPRs =
      isPRStatusGrouping ||
      rightSidebarShowsPR ||
      cardProps.includes('pr') ||
      cardProps.includes('ci')

    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = state.repos.find((r) => r.id === wt.repoId)
        if (!repo) {
          continue
        }

        const branch = wt.branch.replace(/^refs\/heads\//, '')
        if (shouldRefreshPRs && !wt.isBare && branch) {
          const prKey = prCacheKey(repo.path, repo.id, branch, state.settings, repo.connectionId)
          const prEntry = state.prCache[prKey]
          if (!prEntry || now - prEntry.fetchedAt >= CACHE_TTL) {
            const candidate = buildPRRefreshCandidate(state, wt)
            if (candidate) {
              stalePRCandidates.push({
                candidate,
                score:
                  (state.activeWorktreeId === wt.id ? Number.MAX_SAFE_INTEGER : 0) +
                  wt.lastActivityAt
              })
            }
          }
        }
        if (shouldRefreshIssues && wt.linkedIssue) {
          const issueKey = repoScopedCacheKey(repo.path, repo.id, String(wt.linkedIssue))
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(repo.path, wt.linkedIssue, { repoId: repo.id })
          }
        }
      }
    }
    const candidatesToRefresh = stalePRCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, isPRStatusGrouping ? stalePRCandidates.length : 5)
    for (const { candidate } of candidatesToRefresh) {
      if (getRuntimeRepoTarget(state, candidate.repoPath)) {
        void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
          repoId: candidate.repoId,
          linkedPRNumber: candidate.linkedPRNumber ?? null,
          fallbackPRNumber: candidate.fallbackPRNumber ?? null,
          fallbackPRSource: candidate.fallbackPRSource ?? null
        })
      } else {
        void window.api.gh.enqueuePRRefresh?.({ candidate, reason: 'swr', priority: 10 })
      }
    }
  },

  refreshGitHubForWorktree: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repo = state.repos.find((r) => r.id === worktree.repoId)
    if (!repo) {
      return
    }

    // Invalidate this worktree's cache entries
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const prKey = prCacheKey(repo.path, repo.id, branch, state.settings, repo.connectionId)
    const issueKey = worktree.linkedIssue
      ? repoScopedCacheKey(repo.path, repo.id, String(worktree.linkedIssue))
      : ''

    set((s) => {
      const updates: Partial<AppState> = {}
      if (s.prCache[prKey]) {
        updates.prCache = { ...s.prCache, [prKey]: { ...s.prCache[prKey], fetchedAt: 0 } }
      }
      if (issueKey && s.issueCache[issueKey]) {
        updates.issueCache = {
          ...s.issueCache,
          [issueKey]: { ...s.issueCache[issueKey], fetchedAt: 0 }
        }
      }
      return updates
    })

    // Re-fetch (skip when branch is empty — detached HEAD during rebase)
    if (!worktree.isBare && branch) {
      const candidate = buildPRRefreshCandidate(get(), worktree)
      if (candidate) {
        if (getRuntimeRepoTarget(get(), candidate.repoPath)) {
          void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
            force: true,
            repoId: candidate.repoId,
            linkedPRNumber: candidate.linkedPRNumber ?? null,
            fallbackPRNumber: candidate.fallbackPRNumber ?? null,
            fallbackPRSource: candidate.fallbackPRSource ?? null
          })
        } else {
          void window.api.gh.enqueuePRRefresh?.({ candidate, reason: 'post-push', priority: 100 })
        }
      }
    }
    if (shouldRefreshIssueDecorations(state) && worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
    }
  },

  patchWorkItem: (itemId, patch, repoId) => {
    set((s) => {
      const nextCache = { ...s.workItemsCache }
      let changed = false
      for (const key of Object.keys(nextCache)) {
        const entry = nextCache[key]
        if (!entry?.data) {
          continue
        }
        // Why: GitHub issue/PR ids are only unique within a repo. Cross-repo
        // task views can contain the same `pr:42` id from multiple repos.
        const idx = entry.data.findIndex(
          (item) => item.id === itemId && (!repoId || item.repoId === repoId)
        )
        if (idx === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[idx] = { ...updatedItems[idx], ...patch }
        nextCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { workItemsCache: nextCache } : {}
    })
  },

  setIssueSourcePreference: async (repoId, repoPath, preference) => {
    // Why: optimistically patch the local Repo first so the segmented control
    // reflects the new selection on the same frame. On IPC failure we resync
    // from disk via `fetchRepos()` below so the UI doesn't lie about what's
    // persisted.
    set((s) => ({
      repos: s.repos.map((r) =>
        r.id === repoId
          ? {
              ...r,
              issueSourcePreference: preference === 'auto' ? undefined : preference
            }
          : r
      )
    }))
    try {
      // Why: persist via the generic `repos:update` channel rather than a
      // dedicated gh-namespaced handler. Single write path → single
      // `repos:changed` broadcast → other windows re-fetch. The store layer
      // normalizes `'auto'` to `undefined` so the persisted record drops
      // the key entirely (see main/persistence.ts#updateRepo).
      const updates = { issueSourcePreference: preference === 'auto' ? undefined : preference }
      const target = getActiveRuntimeTarget(get().settings)
      await (target.kind === 'local'
        ? window.api.repos.update({ repoId, updates })
        : callRuntimeRpc(target, 'repo.update', { repo: repoId, updates }, { timeoutMs: 15_000 }))
    } catch (err) {
      console.error('Failed to persist issue-source preference:', err)
      // Why: surface the persist failure so the user understands why the
      // pill visually reverts (optimistic patch above → resync via
      // fetchRepos below). Without this toast, the UI silently snaps back
      // and the user has no clue the write failed.
      toast.error(
        translate('auto.store.slices.github.d49ef4b944', 'Failed to save issue-source preference'),
        {
          duration: ERROR_TOAST_DURATION
        }
      )
      // Why: the optimistic patch above may now disagree with disk. Resync
      // rather than leave a lie on screen. We only refetch repos — the cache
      // eviction below is still safe to run; worst case we trigger a
      // harmless re-fetch of work items against the pre-flip preference.
      void get().fetchRepos()
    }
    // Why: wipe in-flight dedupe entries for this repo BEFORE bumping the
    // invalidation nonce. The bump triggers a re-run of TaskPage's fetch
    // effect; if the inflight map still held a pre-flip entry, the new
    // dispatch could collapse onto it and skip the source swap. Clearing
    // first makes the "new fetch gets a fresh request" invariant impossible
    // to trip on later refactors that change zustand or React flush timing.
    clearInflightWorkItemsForRepo(repoId, repoPath)
    // Why: evict every cache entry keyed on this repo AFTER the IPC
    // resolves. If we evicted before awaiting, an overlapping fetch triggered
    // by a different subscriber would hit main with the pre-flip persisted
    // preference and repopulate the cache with stale-source data. Work-items
    // cache keys are repo-scoped, but we also drop legacy path-scoped entries
    // that may have been restored from older persisted cache data.
    set((s) => {
      const prefix = `${repoId}::`
      const legacyPrefix = `${repoPath}::`
      const next: Record<string, CacheEntry<GitHubWorkItem[]>> = {}
      for (const [key, entry] of Object.entries(s.workItemsCache)) {
        if (!key.startsWith(prefix) && !key.startsWith(legacyPrefix)) {
          next[key] = entry
        }
      }
      // Why: bump the invalidation nonce so the Tasks list's fetch effect
      // — which keys on `[selectedRepos, appliedTaskSearch, taskRefreshNonce,
      // taskSource, workItemsInvalidationNonce]` — re-runs and re-populates
      // the just-evicted entries. Evicting alone wouldn't trigger the effect
      // because it doesn't depend on the cache.
      return { workItemsCache: next, workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1 }
    })
  },

  evictGitHubRepoCaches: (repoId, repoPath) => {
    clearInflightWorkItemsForRepo(repoId, repoPath)
    set((s) => {
      const prefixes = repoCacheKeyPrefixes(repoId, repoPath)
      const workItems = evictRepoCacheEntries(s.workItemsCache, prefixes)
      const prs = evictRepoCacheEntries(s.prCache, prefixes)
      const issues = evictRepoCacheEntries(s.issueCache, prefixes)
      const checks = evictRepoCacheEntries(s.checksCache, prefixes)
      const comments = evictRepoCacheEntries(s.commentsCache, prefixes)
      const updates: Partial<AppState> = {}

      if (workItems.evicted) {
        updates.workItemsCache = workItems.cache
        updates.workItemsInvalidationNonce = s.workItemsInvalidationNonce + 1
      }
      if (prs.evicted) {
        updates.prCache = prs.cache
      }
      if (issues.evicted) {
        updates.issueCache = issues.cache
      }
      if (checks.evicted) {
        updates.checksCache = checks.cache
      }
      if (comments.evicted) {
        updates.commentsCache = comments.cache
      }

      return updates
    })
  },

  // Why: activation is the user's strongest freshness signal. A PR can merge
  // seconds after the last sidebar poll; enqueue through the coordinator so
  // clicks revalidate PR state without bypassing coalescing/rate-limit guards.
  refreshGitHubForWorktreeIfStale: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repo = state.repos.find((r) => r.id === worktree.repoId)
    if (!repo) {
      return
    }

    const now = Date.now()
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const cardProps = state.worktreeCardProperties ?? []
    const shouldRefreshPR =
      state.groupBy === 'pr-status' ||
      cardProps.includes('pr') ||
      cardProps.includes('ci') ||
      rightSidebarShowsPullRequestData(state)

    if (shouldRefreshPR && !worktree.isBare && branch) {
      const candidate = buildPRRefreshCandidate(state, worktree)
      if (candidate) {
        if (getRuntimeRepoTarget(state, candidate.repoPath)) {
          void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
            force: true,
            repoId: candidate.repoId,
            linkedPRNumber: candidate.linkedPRNumber ?? null,
            fallbackPRNumber: candidate.fallbackPRNumber ?? null,
            fallbackPRSource: candidate.fallbackPRSource ?? null
          })
        } else {
          void window.api.gh.enqueuePRRefresh?.({ candidate, reason: 'active', priority: 80 })
        }
      }
    }

    if (shouldRefreshIssueDecorations(state) && worktree.linkedIssue) {
      const issueKey = repoScopedCacheKey(repo.path, repo.id, String(worktree.linkedIssue))
      const issueEntry = state.issueCache[issueKey]
      if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
        void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
      }
    }
  }
})
