import type { AppState } from '../types'
import type { CacheEntry } from '../github/cache-model'
import type { JiraSlice, JiraSliceSet } from './jira-slice-contract'
import type {
  JiraConnectionStatus,
  JiraIssue,
  JiraSiteSelection
} from '../../../../shared/jira-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

export type InflightJiraReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

export type SharedJiraSummaryRequest = InflightJiraReadRequest<JiraIssue | null> & {
  controller: AbortController
  subscribers: number
}

export type JiraReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export const inflightIssueRequests = new Map<string, InflightJiraReadRequest<JiraIssue | null>>()
export const inflightIssueSummaryRequests = new Map<string, SharedJiraSummaryRequest>()
export const inflightSearchRequests = new Map<string, InflightJiraReadRequest<JiraIssue[]>>()
export const inflightListRequests = new Map<string, InflightJiraReadRequest<JiraIssue[]>>()

let jiraStatusReadGeneration = 0
let jiraMutationGeneration = 0

export const EMPTY_JIRA_READ_CACHES = {
  jiraIssueCache: {},
  jiraIssueSummaryCache: {},
  jiraSearchCache: {}
} satisfies Partial<JiraSlice>

export function isFreshJiraCacheEntry<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleJiraCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

export function looksLikeJiraAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Jira 403 commonly means endpoint/project access is denied while the token remains valid.
  return /authenticat|unauthorized|401/i.test(message)
}

export function createJiraAbortError(what: string): Error {
  const error = new Error(`Jira ${what} aborted`)
  error.name = 'AbortError'
  return error
}

export function subscribeToJiraSummaryRequest(
  entry: SharedJiraSummaryRequest,
  signal: AbortSignal | undefined
): Promise<JiraIssue | null> {
  if (!signal) {
    entry.subscribers += 1
    return entry.promise
  }
  if (signal.aborted) {
    return Promise.reject(createJiraAbortError('issue summary lookup'))
  }
  entry.subscribers += 1
  return new Promise<JiraIssue | null>((resolve, reject) => {
    const abandon = (): void => {
      entry.subscribers -= 1
      if (entry.subscribers <= 0) {
        entry.controller.abort()
      }
      reject(createJiraAbortError('issue summary lookup'))
    }
    signal.addEventListener('abort', abandon, { once: true })
    const settle = (): void => signal.removeEventListener('abort', abandon)
    entry.promise.then(
      (issue) => {
        settle()
        resolve(issue)
      },
      (error: unknown) => {
        settle()
        reject(error)
      }
    )
  })
}

export function getSelectedJiraSiteId(status: JiraConnectionStatus): JiraSiteSelection | null {
  return status.selectedSiteId ?? status.activeSiteId ?? null
}

export function shouldRefreshJiraStatusAfterRead(
  siteId: JiraSiteSelection | null | undefined,
  status: JiraConnectionStatus,
  options?: { abortable?: boolean }
): boolean {
  if (status.credentialError !== undefined) {
    return true
  }
  // All-site reads can hide per-site failures; typeahead must not recheck on every keystroke.
  return siteId === 'all' && options?.abortable !== true
}

export function clearJiraInflightRequests(): void {
  for (const entry of inflightIssueSummaryRequests.values()) {
    entry.controller.abort()
  }
  inflightIssueRequests.clear()
  inflightIssueSummaryRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

export function beginJiraMutation(): number {
  jiraMutationGeneration += 1
  return jiraMutationGeneration
}

export function currentJiraMutationGeneration(): number {
  return jiraMutationGeneration
}

export function nextJiraStatusReadGeneration(): number {
  jiraStatusReadGeneration += 1
  return jiraStatusReadGeneration
}

export function isCurrentJiraStatusRead(generation: number): boolean {
  return generation === jiraStatusReadGeneration
}

export function isCurrentJiraMutation(generation: number): boolean {
  return generation === jiraMutationGeneration
}

export function isCurrentJiraRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteJiraReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === jiraMutationGeneration &&
    (explicitSource || isCurrentJiraRuntimeContext(contextKey, settings))
  )
}

export function getJiraReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): JiraReadScope {
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${getTaskSourceCacheScope(sourceContext)}`,
    cachePrefix: getTaskSourceCacheScope(sourceContext),
    explicitSource: true
  }
}

export function scopedJiraCacheKey(scope: JiraReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

function jiraConnectionRevisionContextKey(
  settings: AppState['settings'] | TaskSourceContext | null
): string {
  return getProviderRuntimeContextKey(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

function nextJiraConnectionRevisions(
  revisions: Record<string, number>,
  contextKey: string
): Record<string, number> {
  return { ...revisions, [contextKey]: (revisions[contextKey] ?? 0) + 1 }
}

export function markJiraConnectionLost(set: JiraSliceSet, scope: JiraReadScope): void {
  const revisionContextKey = jiraConnectionRevisionContextKey(scope.settings)
  set((state) => ({
    ...(scope.explicitSource ? {} : { jiraStatus: { connected: false, viewer: null } }),
    jiraConnectionRevisions: nextJiraConnectionRevisions(
      state.jiraConnectionRevisions,
      revisionContextKey
    )
  }))
}

export function jiraStatusUpdate(
  state: AppState,
  contextKey: string,
  status: JiraConnectionStatus,
  extra?: Partial<JiraSlice>
): Partial<JiraSlice> {
  return {
    jiraStatus: status,
    jiraStatusChecked: true,
    jiraStatusContextKey: contextKey,
    jiraConnectionRevisions: nextJiraConnectionRevisions(state.jiraConnectionRevisions, contextKey),
    ...extra
  }
}
