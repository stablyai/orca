import { shallow } from 'zustand/shallow'
import type { CacheEntry } from '../../github/cache/cache-model'
import type { AppState } from '../../types'
import type {
  ClickUpConnectionStatus,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
import type { RowLessSource } from '@/runtime/hosts/selection/default-creation-host'
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
  contextKey: string
  /** The runtime the read goes to; only reads of the settings-focused runtime say anything about its connection status. */
  runtimeContextKey: string
  explicitSource: boolean
  source: RowLessSource
  /** The Workspace the host reads for, so a Workspace switch never serves another Workspace's rows. */
  workspaceKey: string
}

type InflightRead = { promise: Promise<unknown>; generation: number }

const inflightReads = new Map<string, InflightRead>()
let connectionGeneration = 0
let statusReadGeneration = 0

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

export function nextClickUpStatusReadGeneration(): number {
  statusReadGeneration += 1
  return statusReadGeneration
}

export function isCurrentClickUpStatusRead(generation: number): boolean {
  return generation === statusReadGeneration
}

export function getClickUpReadScope(
  state: Pick<AppState, 'settings' | 'clickupStatus'>,
  sourceContext?: TaskSourceContext | null
): ClickUpReadScope {
  if (!sourceContext) {
    const runtimeContextKey = getProviderRuntimeContextKey(state.settings)
    return {
      contextKey: runtimeContextKey,
      runtimeContextKey,
      explicitSource: false,
      source: defaultScopeSource(state.settings),
      workspaceKey: state.clickupStatus.selectedWorkspaceId ?? 'none'
    }
  }
  const identity = sourceContext.providerIdentity
  const runtimeContextKey = getProviderRuntimeContextKey(
    getTaskSourceRuntimeSettings(sourceContext)
  )
  return {
    contextKey: `${runtimeContextKey}::${getTaskSourceCacheScope(sourceContext)}`,
    runtimeContextKey,
    explicitSource: true,
    source: sourceContext,
    workspaceKey:
      (identity?.provider === 'clickup' ? identity.workspaceId : null) ??
      state.clickupStatus.selectedWorkspaceId ??
      'none'
  }
}

export function clickupCacheKey(scope: ClickUpReadScope, key: string): string {
  return `${scope.contextKey}::${scope.workspaceKey}::${key}`
}

function filterCacheKey(filter: ClickUpTaskListFilter): string {
  return JSON.stringify([filter.scope, filter.includeClosed, [...(filter.statuses ?? [])].sort()])
}

export function clickupListCacheKey(
  state: Pick<AppState, 'settings' | 'clickupStatus'>,
  sourceContext: TaskSourceContext | null | undefined,
  args: { filter: ClickUpTaskListFilter; page: number }
): string {
  return clickupCacheKey(
    getClickUpReadScope(state, sourceContext),
    `list::${filterCacheKey(args.filter)}::${args.page}`
  )
}

export function clickupSearchCacheKey(
  state: Pick<AppState, 'settings' | 'clickupStatus'>,
  sourceContext: TaskSourceContext | null | undefined,
  args: { query: string; filter: ClickUpTaskListFilter }
): string {
  return clickupCacheKey(
    getClickUpReadScope(state, sourceContext),
    `search::${filterCacheKey(args.filter)}::${args.query}`
  )
}

export function clickupTaskCacheKey(
  state: Pick<AppState, 'settings' | 'clickupStatus'>,
  sourceContext: TaskSourceContext | null | undefined,
  id: string
): string {
  return clickupCacheKey(getClickUpReadScope(state, sourceContext), `task::${id}`)
}

function isSettingsRuntime(scope: ClickUpReadScope, state: AppState): boolean {
  return getProviderRuntimeContextKey(state.settings) === scope.runtimeContextKey
}

function canWriteRead(scope: ClickUpReadScope, generation: number, state: AppState): boolean {
  return (
    generation === connectionGeneration && (scope.explicitSource || isSettingsRuntime(scope, state))
  )
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
  peek: () => CacheEntry<T> | undefined
  store: (entry: CacheEntry<T>) => void
  load: () => Promise<T>
  get: () => AppState
}

/**
 * Serves a fresh cache hit, joins an identical in-flight read, or loads and caches the result.
 * A connection change while the read is out discards its result instead of caching it.
 */
export async function cachedClickUpRead<T>(args: CachedReadArgs<T>): Promise<T> {
  const { key, scope, get } = args
  const cached = args.peek()
  if (!args.force && isFreshClickUpCacheEntry(cached)) {
    return cached.data
  }
  const generation = connectionGeneration
  const inflight = inflightReads.get(key)
  if (!args.force && inflight && inflight.generation === generation) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inflightReads is keyed by the cache key, and each key family always loads the same result type.
    return inflight.promise as Promise<T>
  }
  const promise: Promise<T> = args
    .load()
    .then((data) => {
      if (inflightReads.get(key)?.promise === promise && canWriteRead(scope, generation, get())) {
        args.store({ data, fetchedAt: Date.now() })
      }
      return data
    })
    .catch((error: unknown) => {
      // A failed read may mean the host just revoked the token; the status read decides.
      if (generation === connectionGeneration && isSettingsRuntime(scope, get())) {
        void get().checkClickUpConnection()
      }
      throw error
    })
    .finally(() => {
      if (inflightReads.get(key)?.promise === promise) {
        inflightReads.delete(key)
      }
    })
  inflightReads.set(key, { promise, generation })
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
    ...extra
  }
}
