/**
 * Per-host automation cache with a three-part commit fence.
 *
 * A response may only land if the entry's request generation, the owning
 * authority's catalog generation, and the authority's connection generation all
 * still match what the request captured. That is what stops a slow answer from
 * a re-paired runtime, a re-registered SSH target, or a host the user has since
 * left from overwriting rows that now belong to a different incarnation.
 *
 * Removal tombstones need no separate check: a target leaving the catalog
 * advances that authority's catalog generation, which the same fence rejects.
 */

import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { getAuthorityCatalogGeneration } from './automation-host-catalog-generation'
import {
  AUTOMATION_HOST_CACHE_TTL_MS,
  AUTOMATION_HOST_RETIRED_CACHE_LIMIT,
  DESKTOP_AUTHORITY_CONNECTION_GENERATION,
  type AutomationHostCacheEntry,
  type AutomationHostQueryError,
  type AutomationHostRequestFence,
  type AutomationHostRow
} from './automation-host-cache-types'

export type AutomationHostCacheFreshness = 'missing' | 'fresh' | 'stale'

export type AutomationHostCommitInput = {
  rows: readonly AutomationHostRow[]
  /** Authoritative orphan count when the response carried one. */
  orphanCount?: number | null
}

export type AutomationHostCacheOptions = {
  now?: () => number
  ttlMs?: number
  retiredLimit?: number
  catalogGeneration?: (authority: StableAutomationAuthorityRef) => number
  connectionGeneration?: (authority: StableAutomationAuthorityRef) => number
}

export type AutomationHostCache = {
  get: (ref: StableAutomationCatalogRef) => AutomationHostCacheEntry | null
  getByKey: (stableKey: string) => AutomationHostCacheEntry | null
  freshness: (ref: StableAutomationCatalogRef) => AutomationHostCacheFreshness
  /** Captures the generations a later commit must still match. */
  beginRequest: (ref: StableAutomationCatalogRef) => AutomationHostRequestFence
  /** Publishes an in-flight promise so concurrent callers for the same owner share it. */
  trackRequest: (fence: AutomationHostRequestFence, request: Promise<void>) => void
  pendingRequest: (ref: StableAutomationCatalogRef) => Promise<void> | null
  /** Releases the published request for work that was dropped before it was sent. */
  abandonRequest: (fence: AutomationHostRequestFence) => void
  commit: (fence: AutomationHostRequestFence, input: AutomationHostCommitInput) => boolean
  fail: (fence: AutomationHostRequestFence, error: AutomationHostQueryError) => boolean
  /** Advances the request generation so anything already in flight is discarded. */
  invalidate: (ref: StableAutomationCatalogRef) => void
  /** Same fence bump for a replacement request, but it keeps the retry budget spent so far. */
  supersede: (ref: StableAutomationCatalogRef) => void
  invalidateKey: (stableKey: string) => void
  /**
   * Drops what a host answered under a previous incarnation of itself, keeping
   * its display slot. The stable key survives a re-adoption, so nothing else
   * distinguishes those rows — and the TTL would otherwise report them fresh.
   */
  discardIncarnation: (stableKey: string) => void
  invalidateAuthority: (authority: StableAutomationAuthorityRef) => readonly string[]
  keysForAuthority: (authority: StableAutomationAuthorityRef) => readonly string[]
  evict: (stableKey: string) => void
  keys: () => readonly string[]
  subscribe: (listener: () => void) => () => void
  reset: () => void
}

type CacheRecord = AutomationHostCacheEntry & {
  ref: StableAutomationCatalogRef
  authorityKey: string
}

function defaultConnectionGeneration(authority: StableAutomationAuthorityRef): number {
  // Why: an environment the renderer has not mirrored yet must never look like a match.
  return authority.kind === 'desktop'
    ? DESKTOP_AUTHORITY_CONNECTION_GENERATION
    : (getRuntimeEnvironmentRevision(authority.environmentId) ?? -1)
}

function emptyRecord(ref: StableAutomationCatalogRef, catalogGeneration: number): CacheRecord {
  return {
    ref,
    authorityKey: automationAuthorityCatalogKey(ref.authority),
    data: [],
    fetchedAt: null,
    attempt: 0,
    requestGeneration: 0,
    catalogGeneration,
    request: null,
    error: null,
    orphanCount: null
  }
}

export function createAutomationHostCache(
  options: AutomationHostCacheOptions = {}
): AutomationHostCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? AUTOMATION_HOST_CACHE_TTL_MS
  const retiredLimit = options.retiredLimit ?? AUTOMATION_HOST_RETIRED_CACHE_LIMIT
  const catalogGenerationOf = options.catalogGeneration ?? getAuthorityCatalogGeneration
  const connectionGenerationOf = options.connectionGeneration ?? defaultConnectionGeneration
  const records = new Map<string, CacheRecord>()
  const retired = new Map<string, CacheRecord>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  const ensure = (ref: StableAutomationCatalogRef): CacheRecord => {
    const key = hostStableKey(ref)
    const existing = records.get(key)
    if (existing) {
      return existing
    }
    // A retired entry keeps its generations, so a host coming back cannot commit stale work.
    const revived = retired.get(key)
    if (revived) {
      retired.delete(key)
      records.set(key, revived)
      return revived
    }
    const created = emptyRecord(ref, catalogGenerationOf(ref.authority))
    records.set(key, created)
    return created
  }

  const matchesFence = (record: CacheRecord, fence: AutomationHostRequestFence): boolean =>
    record.requestGeneration === fence.requestGeneration &&
    catalogGenerationOf(record.ref.authority) === fence.catalogGeneration &&
    connectionGenerationOf(record.ref.authority) === fence.connectionGeneration

  // Returns false for an evicted entry too: either way the answer arrived too
  // late to land, and the caller counts that as a discard.
  const settle = (
    fence: AutomationHostRequestFence,
    apply: (record: CacheRecord) => void
  ): boolean => {
    const record = records.get(fence.stableKey)
    if (!record || !matchesFence(record, fence)) {
      return false
    }
    record.request = null
    apply(record)
    notify()
    return true
  }

  const bump = (record: CacheRecord, keepAttempts = false): void => {
    record.requestGeneration += 1
    record.request = null
    if (!keepAttempts) {
      record.attempt = 0
    }
  }

  return {
    get: (ref) => records.get(hostStableKey(ref)) ?? null,
    getByKey: (stableKey) => records.get(stableKey) ?? null,
    freshness: (ref) => {
      const record = records.get(hostStableKey(ref))
      if (!record || record.fetchedAt === null) {
        return 'missing'
      }
      return now() - record.fetchedAt < ttlMs ? 'fresh' : 'stale'
    },
    beginRequest: (ref) => {
      const record = ensure(ref)
      record.catalogGeneration = catalogGenerationOf(ref.authority)
      return {
        stableKey: hostStableKey(ref),
        authorityKey: record.authorityKey,
        requestGeneration: record.requestGeneration,
        catalogGeneration: record.catalogGeneration,
        connectionGeneration: connectionGenerationOf(ref.authority)
      }
    },
    trackRequest: (fence, request) => {
      const record = records.get(fence.stableKey)
      if (record && record.requestGeneration === fence.requestGeneration) {
        record.request = request
      }
    },
    pendingRequest: (ref) => records.get(hostStableKey(ref))?.request ?? null,
    abandonRequest: (fence) => {
      const record = records.get(fence.stableKey)
      if (!record || record.requestGeneration !== fence.requestGeneration) {
        return
      }
      // Why bump rather than only clear the marker: the marker may not be published
      // yet when the job is abandoned, and only a stale generation refuses it later.
      // A left-behind marker reads as in flight and skips the host on every plan.
      bump(record, true)
      notify()
    },
    commit: (fence, input) =>
      settle(fence, (record) => {
        record.data = input.rows
        record.fetchedAt = now()
        record.attempt = 0
        record.error = null
        if (input.orphanCount !== undefined && input.orphanCount !== null) {
          record.orphanCount = input.orphanCount
        }
      }),
    // Why: a failed refresh keeps the last good rows readable and records the error beside them.
    fail: (fence, error) =>
      settle(fence, (record) => {
        record.attempt += 1
        record.error = error
      }),
    invalidate: (ref) => {
      bump(ensure(ref))
      notify()
    },
    supersede: (ref) => {
      bump(ensure(ref), true)
      notify()
    },
    invalidateKey: (stableKey) => {
      const record = records.get(stableKey)
      if (record) {
        bump(record)
        notify()
      }
    },
    discardIncarnation: (stableKey) => {
      const record = records.get(stableKey)
      if (!record) {
        return
      }
      // Bumped as well as emptied: work captured under the old incarnation is
      // still in flight, and its marker would otherwise skip the host forever.
      bump(record)
      record.data = []
      record.fetchedAt = null
      record.error = null
      record.orphanCount = null
      notify()
    },
    invalidateAuthority: (authority) => {
      const authorityKey = automationAuthorityCatalogKey(authority)
      const invalidated: string[] = []
      for (const [key, record] of records) {
        if (record.authorityKey === authorityKey) {
          bump(record)
          invalidated.push(key)
        }
      }
      if (invalidated.length > 0) {
        notify()
      }
      return invalidated
    },
    keysForAuthority: (authority) => {
      const authorityKey = automationAuthorityCatalogKey(authority)
      return [...records].filter(([, r]) => r.authorityKey === authorityKey).map(([key]) => key)
    },
    evict: (stableKey) => {
      const record = records.get(stableKey)
      if (!record) {
        return
      }
      bump(record)
      // Retirement exists to fence, not to display: the generations stay, the
      // payload goes, or the retired pool holds up to 256 stale row arrays. A
      // revived host reads as missing and refetches instead of showing old rows.
      record.data = []
      record.fetchedAt = null
      record.error = null
      record.orphanCount = null
      records.delete(stableKey)
      retired.set(stableKey, record)
      // Insertion order is LRU order here: reviving re-inserts at the end.
      while (retired.size > retiredLimit) {
        const oldest = retired.keys().next()
        if (oldest.done) {
          break
        }
        retired.delete(oldest.value)
      }
      notify()
    },
    keys: () => [...records.keys()],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: () => {
      records.clear()
      retired.clear()
      notify()
    }
  }
}
