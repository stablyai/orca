import { describe, expect, it } from 'vitest'
import type {
  AutomationHostCacheEntry,
  AutomationHostQueryErrorCode
} from './automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import {
  automationHostEntryHealth,
  automationHostLoadCounts,
  withAutomationHostCacheHealth
} from './automation-host-cache-health'

function entry(
  overrides: Partial<AutomationHostCatalogEntry> & Pick<AutomationHostCatalogEntry, 'stableKey'>
): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: null,
    label: 'This computer',
    authorityLabel: 'This computer',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function cached(overrides: Partial<AutomationHostCacheEntry>): AutomationHostCacheEntry {
  return {
    data: [],
    fetchedAt: null,
    attempt: 0,
    requestGeneration: 0,
    catalogGeneration: 0,
    request: null,
    error: null,
    orphanCount: null,
    ...overrides
  }
}

function failure(code: AutomationHostQueryErrorCode): Pick<AutomationHostCacheEntry, 'error'> {
  return { error: { code, message: 'nope', retryable: true, retryAt: null } }
}

const SELF = entry({ stableKey: 'host:desktop:self' })

function catalogOf(entries: AutomationHostCatalogEntry[]): AutomationHostCatalog {
  return {
    entries,
    byStableKey: new Map(entries.map((candidate) => [candidate.stableKey, candidate])),
    hydration: {
      runtimeCatalogSettled: true,
      desktopSshHydrated: true,
      runtimeSshHydratedByEnvironmentId: new Map(),
      savedRuntimeEnvironmentIds: new Set(),
      orphanSettledAuthorityKeys: new Set(),
      unavailableAuthorityKeys: new Set()
    }
  }
}

describe('automation host cache health', () => {
  it('maps a transport failure to unreachable and an old server to incompatible', () => {
    expect(
      automationHostEntryHealth(SELF, {
        entry: () => cached(failure('authority_unavailable'))
      })
    ).toBe('unavailable')
    expect(automationHostEntryHealth(SELF, { entry: () => cached(failure('incompatible')) })).toBe(
      'incompatible'
    )
    expect(automationHostEntryHealth(SELF, { entry: () => cached(failure('timeout')) })).toBe(
      'stale-error'
    )
  })

  it('distinguishes a first load from a refresh over rows already on screen', () => {
    expect(
      automationHostEntryHealth(SELF, {
        entry: () => cached({ request: Promise.resolve() })
      })
    ).toBe('loading')
    expect(
      automationHostEntryHealth(SELF, {
        entry: () => cached({ request: Promise.resolve(), fetchedAt: 5 })
      })
    ).toBe('refreshing')
  })

  it('marks a host whose unscoped list failed, so it never reads as empty', () => {
    expect(
      automationHostEntryHealth(SELF, {
        entry: () => null,
        failedAuthorityKeys: new Set(['authority:desktop'])
      })
    ).toBe('stale-error')
  })

  it('lets a successful host-scoped read outrank the unscoped failure', () => {
    // The per-host read is better evidence about this host than the ambient one.
    expect(
      automationHostEntryHealth(SELF, {
        entry: () => cached({ fetchedAt: 5 }),
        failedAuthorityKeys: new Set(['authority:desktop'])
      })
    ).toBe('fresh')
  })

  it('returns the same catalog when nothing moved', () => {
    const catalog = catalogOf([SELF])
    expect(withAutomationHostCacheHealth(catalog, { entry: () => null })).toBe(catalog)
  })

  it('counts failed hosts and excludes hosts that were never expected to load', () => {
    const catalog = catalogOf([
      SELF,
      entry({ stableKey: 'a', authorityHealth: 'unavailable' }),
      entry({ stableKey: 'b', authorityHealth: 'stale-error' }),
      entry({ stableKey: 'gone', catalogState: 'removed', authorityHealth: 'unavailable' })
    ])

    expect(automationHostLoadCounts(catalog)).toEqual({ failedHostCount: 2, totalHostCount: 3 })
  })
})
