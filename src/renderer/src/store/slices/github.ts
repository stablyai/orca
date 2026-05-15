/* eslint-disable max-lines -- Why: the GitHub slice co-locates all cache + fetch logic for
PR, issue, checks, and comments data so the dedup and invalidation patterns stay consistent. */
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  ClassifiedError,
  GitHubOwnerRepo,
  IssueSourcePreference,
  PRInfo,
  IssueInfo,
  PRCheckDetail,
  PRComment,
  Worktree,
  GitHubWorkItem
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
import { sortWorkItemsByUpdatedAt, PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'
import { syncPRChecksStatus } from './github-checks'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'

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
    default:
      return null
  }
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
}

type RepoScopedFetchOptions = FetchOptions & {
  repoId?: string
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
  { promise: Promise<PRInfo | null>; force: boolean; generation: number }
>()
const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
const inflightChecksRequests = new Map<string, Promise<PRCheckDetail[]>>()
const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
type InflightWorkItems = {
  promise: Promise<GitHubWorkItem[]>
  force: boolean
}
const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
const prRequestGenerations = new Map<string, number>()

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

function repoScopedCacheKey(repoPath: string, repoId: string | undefined, suffix: string): string {
  return `${repoId ?? repoPath}::${suffix}`
}

// Why: 500 entries is generous enough that active developers will never hit it
// during normal use, but prevents the cache from growing without bound across
// many repos and branches over a long-running session.
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined, ttl = CACHE_TTL): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

/**
 * Evict the oldest entries from a cache record when it exceeds the max size.
 * Returns a pruned copy, or the original reference if no eviction was needed.
 */
function evictStaleEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys
    .map((k) => ({ key: k, fetchedAt: cache[k].fetchedAt }))
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
  const keep = new Set(sorted.slice(0, maxEntries).map((e) => e.key))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const k of keep) {
    pruned[k] = cache[k]
  }
  return pruned
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
  // Why: keyed by repoId + limit + query so remote repos with the same path on
  // different SSH targets do not share issue/PR results.
  // from cache instantly on mount (and on hover-prefetch from sidebar buttons)
  // while a background refresh keeps the list fresh.
  workItemsCache: Record<string, CacheEntry<GitHubWorkItem[]>>
  fetchPRForBranch: (
    repoPath: string,
    branch: string,
    options?: RepoScopedFetchOptions & { linkedPRNumber?: number | null }
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
    options?: RepoScopedFetchOptions
  ) => Promise<PRCheckDetail[]>
  fetchPRComments: (
    repoPath: string,
    prNumber: number,
    options?: RepoScopedFetchOptions
  ) => Promise<PRComment[]>
  resolveReviewThread: (
    repoPath: string,
    prNumber: number,
    threadId: string,
    resolve: boolean,
    options?: RepoScopedFetchOptions
  ) => Promise<boolean>
  initGitHubCache: () => Promise<void>
  refreshAllGitHub: () => void
  refreshGitHubForWorktree: (worktreeId: string) => void
  refreshGitHubForWorktreeIfStale: (worktreeId: string) => void
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
   * the caller surfaces as a "N of M repos failed to load" banner. A repo
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
  patchWorkItem: (itemId: string, patch: Partial<GitHubWorkItem>) => void
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
            projectViewCache: {
              ...s.projectViewCache,
              [key]: { data: table, fetchedAt: Date.now() }
            }
          }))
        } else if (maybeKnownKey) {
          // Only stamp the error onto the cache when we have a resolved key
          // (i.e. caller supplied viewId). Otherwise we have nowhere to write
          // it — the renderer classifies the error directly from the envelope.
          set((s) => ({
            projectViewCache: {
              ...s.projectViewCache,
              [maybeKnownKey]: {
                data: s.projectViewCache[maybeKnownKey]?.data ?? null,
                fetchedAt: Date.now(),
                error: envelope.error
              }
            }
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
        error: { type: 'unknown', message: 'Project view not loaded' }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: { type: 'unknown', message: 'Row not found' }
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
        error: { type: 'unknown', message: 'Project view not loaded' }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: { type: 'unknown', message: 'Row not found' }
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
        error: { type: 'unknown', message: 'Project view not loaded' }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: { type: 'unknown', message: 'Row not found' }
      }
    }
    const previousRow = table.rows[rowIndex]
    const { owner, repo, number } = parseSlugAndNumber(previousRow) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: 'Row has no owner/repo/number — cannot patch underlying item'
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
      return { ok: false, error: { type: 'unknown', message: 'Project view not loaded' } }
    }
    const row = table.rows.find((r) => r.id === rowId)
    if (!row) {
      return { ok: false, error: { type: 'unknown', message: 'Row not found' } }
    }
    if (row.itemType !== 'ISSUE') {
      return {
        ok: false,
        error: { type: 'validation_error', message: 'Issue Type can only be set on Issues.' }
      }
    }
    const { owner, repo, number } = parseSlugAndNumber(row) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: { type: 'validation_error', message: 'Row has no owner/repo/number.' }
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

    const existing = inflightWorkItemsRequests.get(key)
    if (existing) {
      // Why: a user-initiated refresh (force=true) must not silently dedupe to
      // a non-forcing fetch already in flight — the result would be no fresher
      // than what the user just asked to invalidate. Wait for the non-forcing
      // request to settle (success or failure — we discard the result either
      // way), then fall through to issue a new forced request. Non-forcing
      // callers continue to dedupe onto any in-flight request as before.
      if (options?.force && !existing.force) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

    const request = (async () => {
      await acquireWorkItemSlot()
      try {
        const envelope = await window.api.gh.listWorkItems({
          repoPath,
          repoId,
          limit,
          query: query || undefined
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
        set((s) => ({
          workItemsCache: {
            ...s.workItemsCache,
            [key]: {
              data: items,
              fetchedAt: Date.now(),
              sources: envelope.sources,
              ...(errorForCache ? { error: errorForCache } : {}),
              ...(envelope.issueSourceFellBack ? { issueSourceFellBack: true } : {})
            }
          }
        }))
        return items
      } catch (err) {
        // Why: surface the error to the caller; keep stale cache entry so the
        // UI can continue to render something useful while the user retries.
        console.error('Failed to fetch GitHub work items:', err)
        throw err
      } finally {
        releaseWorkItemSlot()
        inflightWorkItemsRequests.delete(key)
      }
    })()

    inflightWorkItemsRequests.set(key, {
      promise: request,
      force: Boolean(options?.force)
    })
    return request
  },

  fetchWorkItemsAcrossRepos: async (repos, perRepoLimit, displayLimit, query, options) => {
    const state = get()
    let failedCount = 0
    const perRepoResults = await Promise.all(
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
    const merged = sortWorkItemsByUpdatedAt(perRepoResults.flat()).slice(0, displayLimit)
    return { items: merged, failedCount }
  },

  fetchWorkItemsNextPage: async (repos, perRepoLimit, displayLimit, query, before) => {
    let failedCount = 0
    const perRepoResults = await Promise.all(
      repos.map(async (r) => {
        await acquireWorkItemSlot()
        try {
          const envelope = await window.api.gh.listWorkItems({
            repoPath: r.path,
            repoId: r.repoId,
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
          console.warn(`[workItems] next page ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        } finally {
          releaseWorkItemSlot()
        }
      })
    )
    const merged = sortWorkItemsByUpdatedAt(perRepoResults.flat()).slice(0, displayLimit)
    return { items: merged, failedCount }
  },

  countWorkItemsAcrossRepos: async (repos, query) => {
    const counts = await Promise.all(
      repos.map(async (r) => {
        try {
          return await window.api.gh.countWorkItems({
            repoPath: r.path,
            repoId: r.repoId,
            query: query || undefined
          })
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
    // Skip when the cache is fresh or a request is already in flight.
    if (isFresh(cached, WORK_ITEMS_CACHE_TTL) || inflightWorkItemsRequests.has(key)) {
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
          prCache: persisted.pr || {},
          issueCache: persisted.issue || {}
        })
      }
    } catch (err) {
      console.error('Failed to load GitHub cache from disk:', err)
    }
  },

  fetchPRForBranch: async (repoPath, branch, options): Promise<PRInfo | null> => {
    const repoId = options?.repoId ?? get().repos?.find((repo) => repo.path === repoPath)?.id
    const cacheKey = repoScopedCacheKey(repoPath, repoId, branch)
    const cached = get().prCache[cacheKey]
    // Why: if a prior caller without a linkedPR cached `null` for this branch,
    // the worktree-card lookup (which has a linked PR fallback) would otherwise
    // return null forever. Refetch when the cached miss could now resolve via
    // the linkedPR path.
    const linkedRefetch = cached?.data === null && (options?.linkedPRNumber ?? null) !== null
    if (!options?.force && !linkedRefetch && isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (inflightRequest && (!options?.force || inflightRequest.force) && !linkedRefetch) {
      return inflightRequest.promise
    }

    const generation = (prRequestGenerations.get(cacheKey) ?? 0) + 1
    prRequestGenerations.set(cacheKey, generation)

    const linkedPRNumber = options?.linkedPRNumber ?? null
    const request = (async () => {
      try {
        const pr = await window.api.gh.prForBranch({ repoPath, repoId, branch, linkedPRNumber })
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => ({
            prCache: { ...s.prCache, [cacheKey]: { data: pr, fetchedAt: Date.now() } }
          }))
          debouncedSaveCache(get())
        }
        return pr
      } catch (err) {
        console.error('Failed to fetch PR:', err)
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => ({
            prCache: { ...s.prCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
          }))
          debouncedSaveCache(get())
        }
        return null
      } finally {
        const activeRequest = inflightPRRequests.get(cacheKey)
        if (activeRequest?.generation === generation) {
          inflightPRRequests.delete(cacheKey)
        }
      }
    })()

    inflightPRRequests.set(cacheKey, {
      promise: request,
      force: Boolean(options?.force),
      generation
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
          issueCache: { ...s.issueCache, [cacheKey]: { data: issue, fetchedAt: Date.now() } }
        }))
        debouncedSaveCache(get())
        return issue
      } catch (err) {
        console.error('Failed to fetch issue:', err)
        set((s) => ({
          issueCache: { ...s.issueCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
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

  fetchPRChecks: async (repoPath, prNumber, branch, headSha, options): Promise<PRCheckDetail[]> => {
    const repoId = options?.repoId ?? get().repos?.find((repo) => repo.path === repoPath)?.id
    const cacheKey = repoScopedCacheKey(repoPath, repoId, `pr-checks::${prNumber}`)
    const cached = get().checksCache[cacheKey]
    if (!options?.force && isFresh(cached, CHECKS_CACHE_TTL)) {
      const cachedChecks = cached.data ?? []
      const prStatusUpdate = syncPRChecksStatus(get(), repoPath, branch, cachedChecks)
      if (prStatusUpdate) {
        set(prStatusUpdate)
        debouncedSaveCache(get())
      }
      return cachedChecks
    }

    const inflightRequest = inflightChecksRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const checks = (await window.api.gh.prChecks({
          repoPath,
          repoId,
          prNumber,
          headSha,
          noCache: options?.force
        })) as PRCheckDetail[]
        set((s) => {
          const nextState: Partial<AppState> = {
            checksCache: { ...s.checksCache, [cacheKey]: { data: checks, fetchedAt: Date.now() } }
          }

          const prStatusUpdate = syncPRChecksStatus(s, repoPath, branch, checks)
          if (prStatusUpdate?.prCache) {
            nextState.prCache = prStatusUpdate.prCache
          }

          return nextState
        })
        debouncedSaveCache(get())
        return checks
      } catch (err) {
        console.error('Failed to fetch PR checks:', err)
        return get().checksCache[cacheKey]?.data ?? []
      } finally {
        inflightChecksRequests.delete(cacheKey)
      }
    })()

    inflightChecksRequests.set(cacheKey, request)
    return request
  },

  fetchPRComments: async (repoPath, prNumber, options): Promise<PRComment[]> => {
    const repoId = options?.repoId ?? get().repos?.find((repo) => repo.path === repoPath)?.id
    const cacheKey = repoScopedCacheKey(repoPath, repoId, `pr-comments::${prNumber}`)
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
        const comments = (await window.api.gh.prComments({
          repoPath,
          repoId,
          prNumber,
          noCache: options?.force
        })) as PRComment[]
        set((s) => ({
          commentsCache: {
            ...s.commentsCache,
            [cacheKey]: { data: comments, fetchedAt: Date.now() }
          }
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

  resolveReviewThread: async (repoPath, prNumber, threadId, resolve, options) => {
    const repoId = options?.repoId ?? get().repos?.find((repo) => repo.path === repoPath)?.id
    const cacheKey = repoScopedCacheKey(repoPath, repoId, `pr-comments::${prNumber}`)

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

    const ok = await window.api.gh.resolveReviewThread({ repoPath, repoId, threadId, resolve })
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

  refreshAllGitHub: () => {
    // Invalidate checks and comments caches so they refresh on next access.
    // Also evict old entries from prCache and issueCache to prevent unbounded
    // growth across many repos and branches over a long-running session.
    set((s) => ({
      checksCache: {},
      commentsCache: {},
      prCache: evictStaleEntries(s.prCache),
      issueCache: evictStaleEntries(s.issueCache)
    }))

    // Why: prRequestGenerations tracks generation counters for inflight
    // fetch deduplication. Pruning keys that were just evicted from prCache
    // would race with inflight requests — their generation check would fail
    // and silently discard valid responses. Since each entry is just a number,
    // the memory overhead is negligible; let it shrink naturally as keys stop
    // being fetched. The eviction on prCache/issueCache above is sufficient
    // to bound the dominant source of growth.

    // Only re-fetch PR/issue entries that are already stale — skip fresh ones
    const state = get()
    const now = Date.now()

    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = state.repos.find((r) => r.id === wt.repoId)
        if (!repo) {
          continue
        }

        const branch = wt.branch.replace(/^refs\/heads\//, '')
        if (!wt.isBare && branch) {
          const prKey = repoScopedCacheKey(repo.path, repo.id, branch)
          const prEntry = state.prCache[prKey]
          if (!prEntry || now - prEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchPRForBranch(repo.path, branch, { repoId: repo.id })
          }
        }
        if (wt.linkedIssue) {
          const issueKey = repoScopedCacheKey(repo.path, repo.id, String(wt.linkedIssue))
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(repo.path, wt.linkedIssue, { repoId: repo.id })
          }
        }
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
    const prKey = repoScopedCacheKey(repo.path, repo.id, branch)
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
      void get().fetchPRForBranch(repo.path, branch, { force: true, repoId: repo.id })
    }
    if (worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
    }
  },

  patchWorkItem: (itemId, patch) => {
    set((s) => {
      const nextCache = { ...s.workItemsCache }
      let changed = false
      for (const key of Object.keys(nextCache)) {
        const entry = nextCache[key]
        if (!entry?.data) {
          continue
        }
        const idx = entry.data.findIndex((item) => item.id === itemId)
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
      toast.error('Failed to save issue-source preference', {
        duration: ERROR_TOAST_DURATION
      })
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
    for (const key of Array.from(inflightWorkItemsRequests.keys())) {
      if (key.startsWith(`${repoId}::`) || key.startsWith(`${repoPath}::`)) {
        inflightWorkItemsRequests.delete(key)
      }
    }
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

  // Why: worktree switches previously force-refreshed GitHub data on every
  // click, bypassing the 5-min TTL. This variant only fetches when stale,
  // avoiding unnecessary API calls and latency during rapid switching.
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
    const prKey = repoScopedCacheKey(repo.path, repo.id, branch)
    const prEntry = state.prCache[prKey]
    const prStale = !prEntry || now - prEntry.fetchedAt >= CACHE_TTL

    if (!worktree.isBare && branch && prStale) {
      void get().fetchPRForBranch(repo.path, branch, { force: true, repoId: repo.id })
    }

    if (worktree.linkedIssue) {
      const issueKey = repoScopedCacheKey(repo.path, repo.id, String(worktree.linkedIssue))
      const issueEntry = state.issueCache[issueKey]
      if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
        void get().fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
      }
    }
  }
})
