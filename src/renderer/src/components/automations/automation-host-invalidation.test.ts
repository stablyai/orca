/** Scoped events invalidate one entry, unscoped events their authority, and neither crosses authority boundaries. */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'

import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automations/ownership/automation-owner-ref'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'
import { createAutomationHostInvalidation } from './automation-host-invalidation'

const DESKTOP: StableAutomationAuthorityRef = { kind: 'desktop' }
const RUNTIME: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-1' }
const DESKTOP_SELF: StableAutomationCatalogRef = { authority: DESKTOP, selector: { kind: 'self' } }
const DESKTOP_SSH: StableAutomationCatalogRef = {
  authority: DESKTOP,
  selector: { kind: 'ssh', targetId: 'target-1' }
}
const RUNTIME_SELF: StableAutomationCatalogRef = { authority: RUNTIME, selector: { kind: 'self' } }

function row(id: string): AutomationHostRow {
  return {
    automation: { id } as Automation,
    owner: null,
    selector: { kind: 'self' },
    usageSummary: null,
    usageKnown: false
  }
}

function seeded(): AutomationHostCache {
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  for (const ref of [DESKTOP_SELF, DESKTOP_SSH, RUNTIME_SELF]) {
    cache.commit(cache.beginRequest(ref), { rows: [row('a')] })
  }
  return cache
}

describe('automation host invalidation', () => {
  it('drops queued work once disposed', async () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({ cache, onInvalidated })
    invalidation.handle({ authority: DESKTOP })
    invalidation.dispose()
    await Promise.resolve()
    expect(onInvalidated).not.toHaveBeenCalled()
  })
})
