import { describe, expect, it } from 'vitest'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import { buildAutomationHostCatalog } from './automation-host-catalog'
import type {
  AutomationCatalogSshMirrorInput,
  AutomationHostCatalogInput,
  AutomationRuntimeAuthorityInput
} from './automation-host-catalog-types'
import { resolveAutomationHostFilter } from './automation-host-filter-resolution'

function mirror(
  overrides: Partial<AutomationCatalogSshMirrorInput> = {}
): AutomationCatalogSshMirrorInput {
  return {
    targetsHydrated: true,
    targets: [],
    removedTargetLabels: new Map(),
    connectionStatusByTargetId: new Map(),
    ...overrides
  }
}

function runtime(
  overrides: Partial<AutomationRuntimeAuthorityInput> = {}
): AutomationRuntimeAuthorityInput {
  return {
    environmentId: 'env-1',
    label: 'Build server',
    pairingRevision: 3,
    authorityHealth: 'fresh',
    querySupport: 'scoped',
    ssh: mirror(),
    ...overrides
  }
}

function catalogOf(overrides: Partial<AutomationHostCatalogInput> = {}) {
  return buildAutomationHostCatalog({
    desktop: { label: 'Local Mac', ssh: mirror() },
    runtimes: [],
    runtimeCatalogSettled: true,
    ...overrides
  })
}

function filterFor(host: StableAutomationCatalogRef): AutomationHostFilter {
  return { kind: 'host', host }
}

const desktopSsh = (targetId: string): StableAutomationCatalogRef => ({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId }
})
const runtimeSelf: StableAutomationCatalogRef = {
  authority: { kind: 'runtime', environmentId: 'env-1' },
  selector: { kind: 'self' }
}
const runtimeSsh: StableAutomationCatalogRef = {
  authority: { kind: 'runtime', environmentId: 'env-1' },
  selector: { kind: 'ssh', targetId: 'nested' }
}
const desktopOrphan: StableAutomationCatalogRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'orphan' }
}

describe('resolveAutomationHostFilter', () => {
  it('passes All hosts through untouched', () => {
    expect(resolveAutomationHostFilter({ filter: { kind: 'all' }, catalog: catalogOf() })).toEqual({
      effective: { kind: 'all' },
      entry: null,
      status: 'all',
      announceFallback: false
    })
  })

  it('resolves Desktop + Self immediately', () => {
    const filter = filterFor({ authority: { kind: 'desktop' }, selector: { kind: 'self' } })
    const resolution = resolveAutomationHostFilter({ filter, catalog: catalogOf() })
    expect(resolution.status).toBe('ready')
    expect(resolution.effective).toBe(filter)
    expect(resolution.entry?.label).toBe('Local Mac')
  })

  it('retains a desktop SSH selection until the target list hydrates', () => {
    const filter = filterFor(desktopSsh('pending'))
    const resolution = resolveAutomationHostFilter({
      filter,
      catalog: catalogOf({
        desktop: { label: 'Local Mac', ssh: mirror({ targetsHydrated: false }) }
      })
    })
    expect(resolution).toMatchObject({ status: 'loading', announceFallback: false })
    expect(resolution.effective).toBe(filter)
  })

  it('falls back and announces once desktop SSH absence is authoritative', () => {
    const resolution = resolveAutomationHostFilter({
      filter: filterFor(desktopSsh('gone')),
      catalog: catalogOf()
    })
    expect(resolution).toEqual({
      effective: { kind: 'all' },
      entry: null,
      status: 'removed',
      announceFallback: true
    })
  })

  it('keeps a removed host as a ghost while automations still reference it', () => {
    const host = desktopSsh('gone')
    const key = hostStableKey(host)
    const resolution = resolveAutomationHostFilter({
      filter: filterFor(host),
      catalog: catalogOf({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({ removedTargetLabels: new Map([['gone', 'Old box']]) })
        },
        referencedStableKeys: [key]
      }),
      referencedStableKeys: new Set([key])
    })
    expect(resolution.status).toBe('ghost')
    expect(resolution.announceFallback).toBe(false)
    expect(resolution.entry?.label).toBe('Old box')
  })

  it('drops a tombstoned host that nothing else references', () => {
    const host = desktopSsh('gone')
    const resolution = resolveAutomationHostFilter({
      filter: filterFor(host),
      catalog: catalogOf({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({ removedTargetLabels: new Map([['gone', 'Old box']]) })
        }
      })
    })
    expect(resolution.status).toBe('removed')
    expect(resolution.announceFallback).toBe(true)
  })

  it('retains a Runtime Self selection until the saved runtime catalog settles', () => {
    const filter = filterFor(runtimeSelf)
    expect(
      resolveAutomationHostFilter({ filter, catalog: catalogOf({ runtimeCatalogSettled: false }) })
        .status
    ).toBe('loading')
    expect(resolveAutomationHostFilter({ filter, catalog: catalogOf() })).toMatchObject({
      status: 'removed',
      announceFallback: true
    })
  })

  it('retains a Runtime SSH selection until that runtime bucket hydrates', () => {
    const filter = filterFor(runtimeSsh)
    expect(
      resolveAutomationHostFilter({
        filter,
        catalog: catalogOf({ runtimes: [runtime({ ssh: mirror({ targetsHydrated: false }) })] })
      }).status
    ).toBe('loading')
    expect(
      resolveAutomationHostFilter({ filter, catalog: catalogOf({ runtimes: [runtime()] }) })
    ).toMatchObject({ status: 'removed', announceFallback: true })
  })

  it('accepts a removal tombstone as positive evidence for a nested target', () => {
    const resolution = resolveAutomationHostFilter({
      filter: filterFor(runtimeSsh),
      catalog: catalogOf({
        runtimes: [
          runtime({
            ssh: mirror({
              targetsHydrated: false,
              removedTargetLabels: new Map([['nested', 'Nested box']])
            })
          })
        ]
      })
    })
    expect(resolution.status).toBe('removed')
    expect(resolution.announceFallback).toBe(true)
  })

  it('never claims removal while the owning authority is offline', () => {
    const offline = catalogOf({
      runtimes: [
        runtime({
          authorityHealth: 'unavailable',
          ssh: mirror({ removedTargetLabels: new Map([['nested', 'Nested box']]) })
        })
      ]
    })
    expect(
      resolveAutomationHostFilter({ filter: filterFor(runtimeSsh), catalog: offline })
    ).toMatchObject({ status: 'unavailable', announceFallback: false })
    expect(
      resolveAutomationHostFilter({
        filter: filterFor({
          authority: { kind: 'runtime', environmentId: 'env-1' },
          selector: { kind: 'ssh', targetId: 'never-seen' }
        }),
        catalog: offline
      })
    ).toMatchObject({ status: 'unavailable', announceFallback: false })
  })

  it('settles an orphan selection only on an authoritative orphan count', () => {
    const filter = filterFor(desktopOrphan)
    expect(resolveAutomationHostFilter({ filter, catalog: catalogOf() }).status).toBe('loading')
    expect(
      resolveAutomationHostFilter({
        filter,
        catalog: catalogOf({ desktop: { label: 'Local Mac', ssh: mirror(), orphanCount: 2 } })
      }).status
    ).toBe('ready')
    expect(
      resolveAutomationHostFilter({
        filter,
        catalog: catalogOf({ desktop: { label: 'Local Mac', ssh: mirror(), orphanCount: 0 } })
      })
    ).toMatchObject({ status: 'removed', announceFallback: true })
  })

  it('retains an orphan selection as unavailable while its authority is offline', () => {
    const resolution = resolveAutomationHostFilter({
      filter: filterFor({
        authority: { kind: 'runtime', environmentId: 'env-1' },
        selector: { kind: 'orphan' }
      }),
      catalog: catalogOf({ runtimes: [runtime({ authorityHealth: 'unavailable' })] })
    })
    expect(resolution).toMatchObject({ status: 'unavailable', announceFallback: false })
  })

  it('retains the display selection through a same-id re-pair', () => {
    const filter = filterFor(runtimeSelf)
    const before = resolveAutomationHostFilter({
      filter,
      catalog: catalogOf({ runtimes: [runtime({ pairingRevision: 3 })] })
    })
    const after = resolveAutomationHostFilter({
      filter,
      catalog: catalogOf({ runtimes: [runtime({ pairingRevision: 4 })] })
    })
    expect(after.status).toBe('ready')
    expect(after.entry?.stableKey).toBe(before.entry?.stableKey)
    // The display slot survives; the captured incarnation does not.
    expect(after.entry?.owner).not.toEqual(before.entry?.owner)
  })

  it('retains the selection through a rename', () => {
    const filter = filterFor(runtimeSelf)
    const resolution = resolveAutomationHostFilter({
      filter,
      catalog: catalogOf({ runtimes: [runtime({ label: 'Renamed server' })] })
    })
    expect(resolution.status).toBe('ready')
    expect(resolution.entry?.label).toBe('Renamed server')
    expect(resolution.entry?.stableKey).toBe(hostStableKey(runtimeSelf))
  })
})
