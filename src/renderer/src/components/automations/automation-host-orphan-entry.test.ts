/**
 * How an authority's orphan bucket becomes visible at all.
 *
 * Two independent ways it fails to appear, and fixing one leaves the other: a
 * scoped answer that omits `orphanCount` must stay unsettled rather than commit
 * a fabricated zero, and an old runtime's unscoped answer must report the count
 * it just computed so the entry can bootstrap without an orphan request that
 * only exists once the entry does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import { validateAutomationListResponse } from '../../../../shared/automation-list-response'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache } from './automation-host-cache'
import { createAutomationHostQueryController } from './automation-host-cache-controller'
import {
  AUTOMATION_ORPHAN_ENTRY_LABEL,
  buildAutomationHostCatalog
} from './automation-host-catalog'
import { resetAutomationHostCatalogGenerationsForTests } from './automation-host-catalog-generation'
import {
  automationAuthorityCatalogKey,
  type AutomationCatalogSshMirrorInput,
  type AutomationHostCatalog,
  type AutomationHostQuerySupport
} from './automation-host-catalog-types'
import { resolveAutomationHostFilter } from './automation-host-filter-resolution'
import type { AutomationHostSchedulerTransport } from './automation-host-scheduler'
import type { ScopedAutomationList } from './automation-scoped-list-client'

const RUNTIME: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-1' }
const RUNTIME_ORPHAN: StableAutomationCatalogRef = {
  authority: RUNTIME,
  selector: { kind: 'orphan' }
}
const RUNTIME_ORPHAN_KEY = hostStableKey(RUNTIME_ORPHAN)
const RUNTIME_AUTHORITY_KEY = automationAuthorityCatalogKey(RUNTIME)

const EMPTY_SSH: AutomationCatalogSshMirrorInput = {
  targetsHydrated: true,
  targets: [],
  removedTargetLabels: new Map(),
  connectionStatusByTargetId: new Map()
}

function catalogWith(
  orphanCount: number | null,
  querySupport: AutomationHostQuerySupport,
  referencedStableKeys: readonly string[] = []
): AutomationHostCatalog {
  return buildAutomationHostCatalog({
    desktop: { label: 'Desktop', ssh: EMPTY_SSH },
    runtimes: [
      {
        environmentId: 'env-1',
        label: 'Runtime',
        pairingRevision: 2,
        authorityHealth: 'fresh',
        querySupport,
        ssh: EMPTY_SSH,
        ...(orphanCount === null ? {} : { orphanCount })
      }
    ],
    runtimeCatalogSettled: true,
    referencedStableKeys
  })
}

/** A local record whose project this client cannot resolve; #49's `projectUnverified` case. */
function unverifiedAutomation(id: string): Automation {
  return { id, name: id, projectId: 'repo-gone', executionTargetType: 'local' } as Automation
}

/** Goes through the real validator so an omitted `orphanCount` is omitted the way a host omits it. */
function scopedAnswer(raw: Record<string, unknown>): ScopedAutomationList {
  const validation = validateAutomationListResponse(raw, { kind: 'self' })
  if (!validation.ok) {
    throw new Error(validation.error.message)
  }
  return { ...validation.result, invalidRows: validation.invalidRows }
}

function createController(transport: Partial<AutomationHostSchedulerTransport>) {
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  const controller = createAutomationHostQueryController({
    cache,
    // A runtime whose repos this client has not mirrored: every project lookup misses.
    legacyPartitionContext: () => ({
      repoConnectionId: () => undefined,
      projectsAuthoritative: false
    }),
    isVisible: () => true,
    schedule: (flush) => flush(),
    transport
  })
  return { cache, controller }
}

afterEach(() => {
  resetAutomationHostCatalogGenerationsForTests()
})

describe('an authority that reports no orphan count', () => {
  it('leaves the count unreported rather than parsing it as zero', () => {
    const validation = validateAutomationListResponse(
      { automations: [{ id: 'a1' }], items: [{ automationId: 'a1', selector: { kind: 'self' } }] },
      { kind: 'self' }
    )
    expect(
      validation.ok && validation.result.orphanCount,
      'an omitted orphanCount was committed as an authoritative zero'
    ).toBeUndefined()
  })

  it('keeps the authority unsettled instead of claiming it has no orphans', async () => {
    const listScoped = vi.fn(() => Promise.resolve(scopedAnswer({ automations: [], items: [] })))
    const { controller } = createController({ listScoped })

    await controller.applyCatalog(catalogWith(null, 'scoped'))

    expect(
      controller.authorityOrphanCount(RUNTIME),
      'an authority that reported no orphanCount was recorded as having zero orphans'
    ).toBeNull()
    controller.dispose()
  })

  it('retains a persisted orphan selection as loading rather than dropping it', async () => {
    const listScoped = vi.fn(() => Promise.resolve(scopedAnswer({ automations: [], items: [] })))
    const { controller } = createController({ listScoped })
    await controller.applyCatalog(catalogWith(null, 'scoped'))

    const catalog = catalogWith(controller.authorityOrphanCount(RUNTIME), 'scoped')
    expect(
      catalog.hydration.orphanSettledAuthorityKeys.has(RUNTIME_AUTHORITY_KEY),
      'the orphan bucket settled on an authority that never reported a count'
    ).toBe(false)

    const filter: AutomationHostFilter = { kind: 'host', host: RUNTIME_ORPHAN }
    const resolution = resolveAutomationHostFilter({ filter, catalog })
    expect(
      resolution.status,
      'a persisted orphan selection was dropped without an authoritative count'
    ).toBe('loading')
    expect(resolution.announceFallback).toBe(false)
    controller.dispose()
  })
})

describe('an old runtime answering with one unscoped list', () => {
  it('bootstraps the orphan entry from projectUnverified rows it never requested', async () => {
    const listScoped = vi.fn(() => Promise.resolve(scopedAnswer({ automations: [], items: [] })))
    const listLegacy = vi.fn(() =>
      Promise.resolve([unverifiedAutomation('a1'), unverifiedAutomation('a2')])
    )
    const { cache, controller } = createController({ listScoped, listLegacy })

    // The catalog cannot contain an orphan entry yet: nothing has reported one.
    const first = catalogWith(null, 'legacy-unscoped')
    expect(first.byStableKey.has(RUNTIME_ORPHAN_KEY)).toBe(false)
    await controller.applyCatalog(first)

    expect(
      controller.authorityOrphanCount(RUNTIME),
      'the unscoped answer classified rows as orphans but reported no count for the authority'
    ).toBe(2)

    const second = catalogWith(controller.authorityOrphanCount(RUNTIME), 'legacy-unscoped')
    const orphanEntry = second.byStableKey.get(RUNTIME_ORPHAN_KEY)
    expect(
      orphanEntry?.label,
      'the orphan entry never materialised, so the old runtime shows zero automations'
    ).toBe(AUTOMATION_ORPHAN_ENTRY_LABEL)
    expect(second.hydration.orphanSettledAuthorityKeys.has(RUNTIME_AUTHORITY_KEY)).toBe(true)

    await controller.applyCatalog(second)
    const orphanRows = cache.getByKey(RUNTIME_ORPHAN_KEY)?.data ?? []
    expect(orphanRows.map((row) => row.automation.id)).toEqual(['a1', 'a2'])
    expect(orphanRows.map((row) => row.selector)).toEqual([
      { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.projectUnverified },
      { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.projectUnverified }
    ])
    controller.dispose()
  })

  // Already worked before the bootstrap fix: a persisted orphan selection puts its
  // own entry in the catalog, which is what got the orphan request sent at all.
  it('settles a selected orphan entry the selection itself put in the catalog', async () => {
    const listScoped = vi.fn(() => Promise.resolve(scopedAnswer({ automations: [], items: [] })))
    const listLegacy = vi.fn(() => Promise.resolve([unverifiedAutomation('a1')]))
    const { controller } = createController({ listScoped, listLegacy })

    const filter: AutomationHostFilter = { kind: 'host', host: RUNTIME_ORPHAN }
    await controller.applyCatalog(catalogWith(null, 'legacy-unscoped', [RUNTIME_ORPHAN_KEY]))

    const catalog = catalogWith(controller.authorityOrphanCount(RUNTIME), 'legacy-unscoped', [
      RUNTIME_ORPHAN_KEY
    ])
    const resolution = resolveAutomationHostFilter({ filter, catalog })
    expect(
      resolution.status,
      'a persisted orphan selection stayed loading forever after an old-server unscoped list'
    ).toBe('ready')
    controller.dispose()
  })
})
