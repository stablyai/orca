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

const inflightIssueRequests = new Map<string, Promise<JiraIssue | null>>()
const inflightSearchRequests = new Map<string, Promise<JiraIssue[]>>()
const inflightListRequests = new Map<string, Promise<JiraIssue[]>>()

function getSelectedSiteId(status: JiraConnectionStatus): JiraSiteSelection | null {
  return status.selectedSiteId ?? status.activeSiteId ?? null
}

function clearJiraInflight(): void {
  inflightIssueRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

export type JiraSlice = {
  jiraStatus: JiraConnectionStatus
  jiraStatusChecked: boolean
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
  jiraIssueCache: {},
  jiraSearchCache: {},

  checkJiraConnection: async () => {
    try {
      const status = await jiraStatus(get().settings)
      const prev = get().jiraStatus
      if (
        prev.connected !== status.connected ||
        prev.viewer?.email !== status.viewer?.email ||
        getSelectedSiteId(prev) !== getSelectedSiteId(status) ||
        (prev.sites?.length ?? 0) !== (status.sites?.length ?? 0)
      ) {
        set({ jiraStatus: status, jiraStatusChecked: true })
      } else if (!get().jiraStatusChecked) {
        set({ jiraStatusChecked: true })
      }
    } catch {
      if (get().jiraStatus.connected) {
        set({ jiraStatus: { connected: false, viewer: null }, jiraStatusChecked: true })
      } else if (!get().jiraStatusChecked) {
        set({ jiraStatusChecked: true })
      }
    }
  },

  connectJira: async (args) => {
    try {
      const result = await jiraConnect(get().settings, args)
      if (result.ok) {
        set({ jiraStatus: { connected: true, viewer: result.viewer }, jiraStatusChecked: true })
        void get().checkJiraConnection()
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testJiraConnection: async (siteId) => {
    try {
      const result = await jiraTestConnection(get().settings, siteId)
      const status = await jiraStatus(get().settings)
      set({ jiraStatus: status, jiraStatusChecked: true })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  selectJiraSite: async (siteId) => {
    const status = await jiraSelectSite(get().settings, siteId)
    clearJiraInflight()
    set({
      jiraStatus: status,
      jiraIssueCache: {},
      jiraSearchCache: {},
      jiraStatusChecked: true
    })
  },

  disconnectJira: async (siteId) => {
    await jiraDisconnect(get().settings, siteId)
    clearJiraInflight()
    const status = await jiraStatus(get().settings)
    set({
      jiraStatus: status.connected ? status : { connected: false, viewer: null },
      jiraIssueCache: {},
      jiraSearchCache: {},
      jiraStatusChecked: true
    })
  },

  fetchJiraIssue: async (key, siteId) => {
    const issueCacheKey = `${siteId ?? 'selected'}::${key}`
    const cached = get().jiraIssueCache[issueCacheKey] ?? get().jiraIssueCache[key]
    if (isFresh(cached)) {
      return cached.data
    }
    const inflight = inflightIssueRequests.get(issueCacheKey)
    if (inflight) {
      return inflight
    }
    const promise = jiraGetIssue(get().settings, key, siteId)
      .then((issue) => {
        set((s) => ({
          jiraIssueCache: evictStaleEntries({
            ...s.jiraIssueCache,
            [issueCacheKey]: { data: issue, fetchedAt: Date.now() }
          })
        }))
        return issue
      })
      .catch((error) => {
        console.warn('[jira] fetchJiraIssue failed:', error)
        if (looksLikeAuthError(error)) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return null
      })
      .finally(() => {
        inflightIssueRequests.delete(issueCacheKey)
      })
    inflightIssueRequests.set(issueCacheKey, promise)
    return promise
  },

  searchJiraIssues: async (jql, limit = 30) => {
    const siteId = getSelectedSiteId(get().jiraStatus)
    const cacheKey = `${siteId ?? 'default'}::${jql}::${limit}`
    const cached = get().jiraSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }
    const promise = jiraSearchIssues(get().settings, jql, limit, siteId)
      .then((issues) => {
        set((s) => ({
          jiraSearchCache: evictStaleEntries({
            ...s.jiraSearchCache,
            [cacheKey]: { data: issues, fetchedAt: Date.now() }
          })
        }))
        return issues
      })
      .catch((error) => {
        console.warn('[jira] searchJiraIssues failed:', error)
        if (looksLikeAuthError(error)) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightSearchRequests.delete(cacheKey)
      })
    inflightSearchRequests.set(cacheKey, promise)
    return promise
  },

  listJiraIssues: async (filter = 'assigned', limit = 30) => {
    const siteId = getSelectedSiteId(get().jiraStatus)
    const cacheKey = `${siteId ?? 'default'}::list::${filter}::${limit}`
    const cached = get().jiraSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }
    const promise = jiraListIssues(get().settings, filter, limit, siteId)
      .then((issues) => {
        set((s) => ({
          jiraSearchCache: evictStaleEntries({
            ...s.jiraSearchCache,
            [cacheKey]: { data: issues, fetchedAt: Date.now() }
          })
        }))
        return issues
      })
      .catch((error) => {
        console.warn('[jira] listJiraIssues failed:', error)
        if (looksLikeAuthError(error)) {
          set({ jiraStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightListRequests.delete(cacheKey)
      })
    inflightListRequests.set(cacheKey, promise)
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
