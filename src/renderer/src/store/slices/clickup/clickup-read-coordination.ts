import { shallow } from 'zustand/shallow'
import type { CacheEntry } from '../../github/cache/cache-model'
import type { AppState } from '../../types'
import type {
  ClickUpConnectionStatus,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getEnvironmentRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import type { ClickUpSlice } from './clickup-slice-contract'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 300

export const EMPTY_CLICKUP_READ_CACHES = {
  clickupTaskCache: {},
  clickupListCache: {},
  clickupCommentCache: {},
  clickupStatusOptionsCache: {}
} satisfies Partial<ClickUpSlice>

export type ClickUpReadScope = {
  /** Runtime, Workspace and source scope, in that order. */
  contextKey: string
  /** The runtime the read goes to; only its own reads say anything about its connection status. */
  runtimeContextKey: string
  target: RuntimeClientTarget
  /** The Workspace the host reads for, so a Workspace switch never serves another Workspace's rows. */
  workspaceKey: string
  /** The Workspace the cache key names, sent so the host refuses a read for another one; null when none is known. */
  workspaceId: string | null
}

type InflightRead = { promise: Promise<unknown>; generation: number }

const inflightReads = new Map<string, InflightRead>()
let connectionGeneration = 0
let statusReadGeneration = 0
/** Counts the status writes that succeeded per runtime and Workspace prefix. */
const statusWriteGenerations = new Map<string, number>()

export function beginClickUpConnectionChange(): number {
  connectionGeneration += 1
  inflightReads.clear()
  return connectionGeneration
}

export function currentClickUpConnectionGeneration(): number {
  return connectionGeneration
}

export function isCurrentClickUpConnectionChange(generation: number): boolean {
  return generation === connectionGeneration
}

/** Called once a status write succeeded: reads that started before it may carry the old status. */
export function noteClickUpStatusWrite(prefix: string): void {
  statusWriteGenerations.set(prefix, (statusWriteGenerations.get(prefix) ?? 0) + 1)
}

export function nextClickUpStatusReadGeneration(): number {
  statusReadGeneration += 1
  return statusReadGeneration
}

export function isCurrentClickUpStatusRead(generation: number): boolean {
  return generation === statusReadGeneration
}

/** Context key of a ClickUp owner's runtime; the owner is passed in, never read from the focused server. */
export function clickupOwnerContextKey(owner: RuntimeClientTarget): string {
  return getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(owner))
}

type ClickUpScopeState = Pick<AppState, 'clickupStatus' | 'clickupStatusContextKey'>

/** The Workspace a source context binds itself to; null when it has none and reads the status slot's. */
export function clickupSourceContextWorkspaceId(sourceContext: TaskSourceContext): string | null {
  const identity = sourceContext.providerIdentity
  return (identity?.provider === 'clickup' ? identity.workspaceId : null) ?? null
}

export function getClickUpReadScope(
  state: ClickUpScopeState,
  sourceContext: TaskSourceContext
): ClickUpReadScope {
  const target = taskSourceRuntimeTarget(sourceContext)
  const runtimeContextKey = clickupOwnerContextKey(target)
  // The status slot holds one runtime's Workspace; another runtime's reads must not borrow it.
  const slotDescribesRuntime = state.clickupStatusContextKey === runtimeContextKey
  const workspaceId =
    clickupSourceContextWorkspaceId(sourceContext) ??
    (slotDescribesRuntime ? state.clickupStatus.selectedWorkspaceId : null)
  // Encoded and tagged, so no id (even one holding `::` or spelling a sentinel) can equal another key.
  const workspaceKey =
    workspaceId !== null
      ? `id:${encodeURIComponent(workspaceId)}`
      : slotDescribesRuntime
        ? 'none'
        : 'unknown-workspace'
  return {
    contextKey: `${clickupWorkspaceCachePrefix(runtimeContextKey, workspaceKey)}${getTaskSourceCacheScope(sourceContext)}`,
    runtimeContextKey,
    target,
    workspaceKey,
    workspaceId
  }
}

/** Leads every cache key; the runtime key and the encoded Workspace key never contain `::`, so a prefix match cannot cross either. */
export function clickupWorkspaceCachePrefix(
  runtimeContextKey: string,
  workspaceKey: string
): string {
  return `${runtimeContextKey}::${workspaceKey}::`
}

export function clickupCacheKey(scope: ClickUpReadScope, key: string): string {
  return `${scope.contextKey}::${key}`
}

function filterCacheKey(filter: ClickUpTaskListFilter): string {
  return JSON.stringify([filter.scope, filter.includeClosed, [...(filter.statuses ?? [])].sort()])
}

export function clickupListCacheKey(
  state: ClickUpScopeState,
  sourceContext: TaskSourceContext,
  args: { filter: ClickUpTaskListFilter; page: number }
): string {
  return clickupCacheKey(
    getClickUpReadScope(state, sourceContext),
    `list::${filterCacheKey(args.filter)}::${args.page}`
  )
}

export function clickupSearchCacheKey(
  state: ClickUpScopeState,
  sourceContext: TaskSourceContext,
  args: { query: string; filter: ClickUpTaskListFilter }
): string {
  return clickupCacheKey(
    getClickUpReadScope(state, sourceContext),
    `search::${filterCacheKey(args.filter)}::${args.query}`
  )
}

export function clickupTaskCacheKey(
  state: ClickUpScopeState,
  sourceContext: TaskSourceContext,
  id: string
): string {
  return clickupCacheKey(getClickUpReadScope(state, sourceContext), `task::${id}`)
}

function describesStatusSlot(scope: ClickUpReadScope, state: AppState): boolean {
  return state.clickupStatusContextKey === scope.runtimeContextKey
}

function canWriteRead(generation: number): boolean {
  return generation === connectionGeneration
}

export function isFreshClickUpCacheEntry<T>(
  entry: CacheEntry<T> | undefined
): entry is CacheEntry<T> & { data: T } {
  return entry !== undefined && entry.data !== null && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleClickUpCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) {
    return cache
  }
  const newest = keys
    .sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
    .slice(keys.length - MAX_CACHE_ENTRIES)
  return Object.fromEntries(newest.map((key) => [key, cache[key]]))
}

type CachedReadArgs<T> = {
  key: string
  scope: ClickUpReadScope
  force?: boolean
  /** A cancellable read is never shared: one caller aborting must not fail another that joined it. */
  signal?: AbortSignal
  /** Rows that carry a task's status; such a read is repeated when a status write succeeded while it was out. */
  carriesTaskStatus?: boolean
  peek: () => CacheEntry<T> | undefined
  store: (entry: CacheEntry<T>) => void
  load: () => Promise<T>
  get: () => AppState
}

/** A read is repeated at most this often, so a burst of writes cannot keep it looping. */
const MAX_STATUS_WRITE_RELOADS = 2

async function loadAcrossStatusWrites<T>(args: CachedReadArgs<T>): Promise<T> {
  if (!args.carriesTaskStatus) {
    return args.load()
  }
  const prefix = clickupWorkspaceCachePrefix(args.scope.runtimeContextKey, args.scope.workspaceKey)
  const generation = connectionGeneration
  for (let reloads = 0; ; reloads += 1) {
    const written = statusWriteGenerations.get(prefix) ?? 0
    const data = await args.load()
    // Past the cap the result is used as is: a write that landed in between re-applied its status to the
    // copies cached then, and a stale row left from a later burst is replaced by the next read after the TTL.
    if (
      (statusWriteGenerations.get(prefix) ?? 0) === written ||
      reloads === MAX_STATUS_WRITE_RELOADS ||
      generation !== connectionGeneration ||
      args.signal?.aborted
    ) {
      return data
    }
  }
}

/**
 * Serves a fresh cache hit, joins an identical in-flight read, or loads and caches the shared result.
 * A connection change while the read is out discards its result instead of caching it, and a
 * status write that succeeded meanwhile makes a status-carrying read load again.
 */
export async function cachedClickUpRead<T>(args: CachedReadArgs<T>): Promise<T> {
  const { key, scope, get } = args
  const cached = args.peek()
  if (!args.force && isFreshClickUpCacheEntry(cached)) {
    return cached.data
  }
  const generation = connectionGeneration
  const shared = args.signal === undefined
  const inflight = inflightReads.get(key)
  if (shared && !args.force && inflight && inflight.generation === generation) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inflightReads is keyed by the cache key, and each key family always loads the same result type.
    return inflight.promise as Promise<T>
  }
  const promise: Promise<T> = loadAcrossStatusWrites(args)
    .then((data) => {
      if ((!shared || inflightReads.get(key)?.promise === promise) && canWriteRead(generation)) {
        args.store({ data, fetchedAt: Date.now() })
      }
      return data
    })
    .catch((error: unknown) => {
      // A failed read may mean the host just revoked the token; the status read decides.
      if (
        !args.signal?.aborted &&
        generation === connectionGeneration &&
        describesStatusSlot(scope, get())
      ) {
        void get().checkClickUpConnection(scope.target)
      }
      throw error
    })
    .finally(() => {
      if (inflightReads.get(key)?.promise === promise) {
        inflightReads.delete(key)
      }
    })
  if (shared) {
    inflightReads.set(key, { promise, generation })
  }
  return promise
}

export function hasClickUpStatusChanged(
  previous: ClickUpConnectionStatus,
  next: ClickUpConnectionStatus
): boolean {
  return (
    previous.connected !== next.connected ||
    previous.credentialError !== next.credentialError ||
    previous.credentialProtection !== next.credentialProtection ||
    previous.selectedWorkspaceId !== next.selectedWorkspaceId ||
    !shallow(previous.viewer, next.viewer) ||
    previous.workspaces.length !== next.workspaces.length ||
    previous.workspaces.some((workspace, index) => !shallow(workspace, next.workspaces[index]))
  )
}

export function clickupStatusUpdate(
  contextKey: string,
  status: ClickUpConnectionStatus,
  extra?: Partial<ClickUpSlice>
): Partial<ClickUpSlice> {
  return {
    clickupStatus: status,
    clickupStatusChecked: true,
    clickupStatusContextKey: contextKey,
    clickupRuntimeUpdateRequired: false,
    ...extra
  }
}
