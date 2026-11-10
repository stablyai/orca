import { describe, expect, it } from 'vitest'
import type { AutomationHostCacheEntry } from './automation-host-cache-types'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { automationHostEntryHealth } from './automation-host-cache-health'

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

const SELF = entry({ stableKey: 'host:desktop:self' })

describe('automation host cache health', () => {
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
})
