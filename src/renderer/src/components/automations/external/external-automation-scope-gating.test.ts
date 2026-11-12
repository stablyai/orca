import { describe, expect, it } from 'vitest'

import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { externalAutomationProbeOwners } from './external-automation-scope-gating'

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    stableKey: 'host:desktop:self',
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

const runtimeEntry = entry({
  stableRef: { authority: { kind: 'runtime', environmentId: 'env-1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:env-1:self',
  label: 'Build box',
  authorityLabel: 'Build box'
})

describe('external automation scope gating', () => {
  it('retains probe owners only for hosts that are actually listed', () => {
    expect(externalAutomationProbeOwners([entry(), runtimeEntry, entry({ owner: null })])).toEqual([
      { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    ])
  })
})
