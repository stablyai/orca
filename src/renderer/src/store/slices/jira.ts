/* eslint-disable max-lines -- Why: the Jira slice owns site status, issue
   caches, and optimistic patch propagation as one store boundary so active
   site changes invalidate every related query coherently. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  JiraConnectionStatus,
  JiraIssue,
  JiraIssueFilter,
  JiraSiteSelection,
  JiraViewer
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import {
  jiraConnect,
  jiraDisconnect,
  jiraGetIssue,
  jiraListIssues,
  jiraSearchIssues,
  jiraSelectSite,
  jiraStatus,
  jiraTestConnection
} from '@/runtime/runtime-jira-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

function evictStaleEntries<T>(
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

function looksLikeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /authenticat|unauthorized|forbidden|401|403/i.test(msg)
}

type InflightJiraReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

const inflightIssueRequests = new Map<string, InflightJiraReadRequest<JiraIssue | null>>()
const inflightSearchRequests = new Map<string, InflightJiraReadRequest<JiraIssue[]>>()
const inflightListRequests = new Map<string, InflightJiraReadRequest<JiraIssue[]>>()
let jiraStatusReadGeneration = 0
let jiraMutationGeneration = 0

function getSelectedSiteId(status: JiraConnectionStatus): JiraSiteSelection | null {
  return status.selectedSiteId ?? status.activeSiteId ?? null
}

function clearJiraInflight(): void {
  inflightIssueRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

function beginJiraMutation(): number {
  jiraMutationGeneration += 1
  return jiraMutationGeneration
}

function isCurrentJiraMutation(generation: number): boolean {
  return generation === jiraMutationGeneration
}

function isCurrentJiraRuntimeContext(contextKey: string, settings: AppState['settings']): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

function canWriteJiraReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings']
): boolean {
  return (
    mutationGeneration === jiraMutationGeneration &&
    isCurrentJiraRuntimeContext(contextKey, settings)
  )
}

export type JiraSlice = {
  jiraStatus: JiraConnectionStatus
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  jiraIssueCache: Record<string, CacheEntry<JiraIssue>>
  jiraSearchCache: Record<string, CacheEntry<JiraIssue[]>>

  checkJiraConnection: () => Promise<void>
  connectJira: (args: {
    siteUrl: string
    email: string
    apiToken: string
  }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  testJiraConnection: (
    siteId?: string | null
  ) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  selectJiraSite: (siteId: JiraSiteSelection) => Promise<void>
  disconnectJira: (siteId?: string | null) => Promise<void>
  fetchJiraIssue: (key: string, siteId?: string | null) => Promise<JiraIssue | null>
  searchJiraIssues: (jql: string, limit?: number) => Promise<JiraIssue[]>
  listJiraIssues: (filter?: JiraIssueFilter, limit?: number) => Promise<JiraIssue[]>
  patchJiraIssue: (issueKey: string, patch: Partial<JiraIssue>) => void
}

export const createJiraSlice: StateCreator<AppState, [], [], JiraSlice> = (set, get) => ({
  jiraStatus: { connected: false, viewer: null },
  jiraStatusChecked: false,
  jiraStatusContextKey: null,
  jiraIssueCache: {},
  jiraSearchCache: {},

  checkJiraConnection: async () => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const statusReadGeneration = (jiraStatusReadGeneration += 1)
    const mutationGeneration = jiraMutationGeneration
    if (get().jiraStatusContextKey !== contextKey) {
      set({ jiraStatusChecked: false })
    }
    try {
      const status = await jiraStatus(get().settings)
      if (
        mutationGeneration !== jiraMutationGeneration ||
        statusReadGeneration !== jiraStatusReadGeneration ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      const prev = get().jiraStatus
      if (
        prev.connected !== status.connected ||
        prev.credentialError !== status.credentialError ||
        prev.viewer?.email !== status.viewer?.email ||
        getSelectedSiteId(prev) !== getSelectedSiteId(status) ||
        (prev.sites?.length ?? 0) !== (status.sites?.length ?? 0)
      ) {
        set({ jiraStatus: status, jiraStatusChecked: true, jiraStatusContextKey: contextKey })
      } else if (!get().jiraStatusChecked) {
        set({ jiraStatusChecked: true, jiraStatusContextKey: contextKey })
      } else if (get().jiraStatusContextKey !== contextKey) {
        set({ jiraStatusContextKey: contextKey })
      }
    } catch {
      if (
        mutationGeneration !== jiraMutationGeneration ||
        statusReadGeneration !== jiraStatusReadGeneration ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      if (get().jiraStatus.connected) {
        set({
          jiraStatus: { connected: false, viewer: null },
          jiraStatusChecked: true,
          jiraStatusContextKey: contextKey
        })
      } else if (!get().jiraStatusChecked) {
        set({ jiraStatusChecked: true, jiraStatusContextKey: contextKey })
      } else if (get().jiraStatusContextKey !== contextKey) {
        set({ jiraStatusContextKey: contextKey })
      }
    }
  },

  connectJira: async (args) => {
    const requestGeneration = beginJiraMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await jiraConnect(get().settings, args)
      if (
        result.ok &&
        isCurrentJiraMutation(requestGeneration) &&
        isCurrentJiraRuntimeContext(contextKey, get().settings)
      ) {
        set({
          jiraStatus: { connected: true, viewer: result.viewer },
          jiraStatusChecked: true,
          jiraStatusContextKey: contextKey
        })
        void get().checkJiraConnection()
      } else if (result.ok) {
        return {
          ok: false as const,
          error: translate(
            'auto.store.slices.jira.856083302c',
            'Jira connection was superseded by a newer request.'
          )
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testJiraConnection: async (siteId) => {
    const requestGeneration = beginJiraMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await jiraTestConnection(get().settings, siteId)
      if (
        !isCurrentJiraMutation(requestGeneration) ||
        !isCurrentJiraRuntimeContext(contextKey, get().settings)
      ) {
        return result
      }
      const status = await jiraStatus(get().settings)
      if (
        isCurrentJiraMutation(requestGeneration) &&
        isCurrentJiraRuntimeContext(contextKey, get().settings)
      ) {
        set({ jiraStatus: status, jiraStatusChecked: true, jiraStatusContextKey: contextKey })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  selectJiraSite: async (siteId) => {
    const requestGeneration = beginJiraMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const status = await jiraSelectSite(get().settings, siteId)
    if (
      !isCurrentJiraMutation(requestGeneration) ||
      getProviderRuntimeContextKey(get().settings) !== contextKey
    ) {
      return
    }
    clearJiraInflight()
    set({
      jiraStatus: status,
      jiraIssueCache: {},
      jiraSearchCache: {},
      jiraStatusChecked: true,
      jiraStatusContextKey: contextKey
    })
  },

  disconnectJira: async (siteId) => {
    const requestGeneration = beginJiraMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    await jiraDisconnect(get().settings, siteId)
    if (
      !isCurrentJiraMutation(requestGeneration) ||
      !isCurrentJiraRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    clearJiraInflight()
    const status = await jiraStatus(get().settings)
    if (
      !isCurrentJiraMutation(requestGeneration) ||
      !isCurrentJiraRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    set({
      jiraStatus: status.connected ? status : { connected: false, viewer: null },
      jiraIssueCache: {},
      jiraSearchCache: {},
      jiraStatusChecked: true,
      jiraStatusContextKey: contextKey
    })
  },

  fetchJiraIssue: async (key, siteId) => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const issueCacheKey = `${siteId ?? 'selected'}::${key}`
    const cached = get().jiraIssueCache[issueCacheKey] ?? get().jiraIssueCache[key]
    if (isFresh(cached)) {
      return cached.data
    }
    const inflight = inflightIssueRequests.get(issueCacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === jiraMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightJiraReadRequest<JiraIssue | null>
    const requestMutationGeneration = jiraMutationGeneration
    const promise = jiraGetIssue(get().settings, key, siteId)
      .then((issue) => {
        if (
          inflightIssueRequests.get(issueCacheKey) === entry &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set((s) => ({
            jiraIssueCache: evictStaleEntries({
              ...s.jiraIssueCache,
              [issueCacheKey]: { data: issue, fetchedAt: Date.now() }
            })
          }))
        }
        return issue
      })
      .catch((error) => {
        console.warn('[jira] fetchJiraIssue failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          void get().checkJiraConnection()
        } else if (
          looksLikeAuthError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return null
      })
      .finally(() => {
        if (inflightIssueRequests.get(issueCacheKey) === entry) {
          inflightIssueRequests.delete(issueCacheKey)
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightIssueRequests.set(issueCacheKey, entry)
    return promise
  },

  searchJiraIssues: async (jql, limit = 30) => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const siteId = getSelectedSiteId(get().jiraStatus)
    const cacheKey = `${siteId ?? 'default'}::${jql}::${limit}`
    const cached = get().jiraSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === jiraMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightJiraReadRequest<JiraIssue[]>
    const requestMutationGeneration = jiraMutationGeneration
    const promise = jiraSearchIssues(get().settings, jql, limit, siteId)
      .then((issues) => {
        if (
          inflightSearchRequests.get(cacheKey) === entry &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set((s) => ({
            jiraSearchCache: evictStaleEntries({
              ...s.jiraSearchCache,
              [cacheKey]: { data: issues, fetchedAt: Date.now() }
            })
          }))
        }
        return issues
      })
      .catch((error) => {
        console.warn('[jira] searchJiraIssues failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          void get().checkJiraConnection()
        } else if (
          looksLikeAuthError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        if (inflightSearchRequests.get(cacheKey) === entry) {
          inflightSearchRequests.delete(cacheKey)
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightSearchRequests.set(cacheKey, entry)
    return promise
  },

  listJiraIssues: async (filter = 'assigned', limit = 30) => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const siteId = getSelectedSiteId(get().jiraStatus)
    const cacheKey = `${siteId ?? 'default'}::list::${filter}::${limit}`
    const cached = get().jiraSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === jiraMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightJiraReadRequest<JiraIssue[]>
    const requestMutationGeneration = jiraMutationGeneration
    const promise = jiraListIssues(get().settings, filter, limit, siteId)
      .then((issues) => {
        if (
          inflightListRequests.get(cacheKey) === entry &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set((s) => ({
            jiraSearchCache: evictStaleEntries({
              ...s.jiraSearchCache,
              [cacheKey]: { data: issues, fetchedAt: Date.now() }
            })
          }))
        }
        return issues
      })
      .catch((error) => {
        console.warn('[jira] listJiraIssues failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          void get().checkJiraConnection()
        } else if (
          looksLikeAuthError(error) &&
          canWriteJiraReadResult(contextKey, requestMutationGeneration, get().settings)
        ) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === entry) {
          inflightListRequests.delete(cacheKey)
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightListRequests.set(cacheKey, entry)
    return promise
  },

  patchJiraIssue: (issueKey, patch) => {
    set((s) => {
      let changed = false
      const nextIssueCache = { ...s.jiraIssueCache }
      for (const [key, entry] of Object.entries(nextIssueCache)) {
        if (entry?.data?.key !== issueKey) {
          continue
        }
        nextIssueCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
        changed = true
      }
      const nextSearchCache = { ...s.jiraSearchCache }
      for (const key of Object.keys(nextSearchCache)) {
        const entry = nextSearchCache[key]
        if (!entry?.data) {
          continue
        }
        const index = entry.data.findIndex((issue) => issue.key === issueKey)
        if (index === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[index] = { ...updatedItems[index], ...patch }
        nextSearchCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { jiraIssueCache: nextIssueCache, jiraSearchCache: nextSearchCache } : {}
    })
  }
})
