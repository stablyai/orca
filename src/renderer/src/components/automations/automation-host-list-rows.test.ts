import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationHostCacheEntry, AutomationHostRow } from './automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import {
  filterAutomationHostGroups,
  resolveAutomationHostListRows
} from './automation-host-list-rows'

function entry(
  overrides: Partial<AutomationHostCatalogEntry> & Pick<AutomationHostCatalogEntry, 'stableRef'>
): AutomationHostCatalogEntry {
  return {
    owner: null,
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

const DESKTOP_SELF = entry({
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
})
const DESKTOP_ORPHAN = entry({
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'orphan' } },
  stableKey: 'host:desktop:orphan',
  label: 'Unassigned legacy automations',
  kind: 'orphan'
})
const RUNTIME_SELF = entry({
  stableRef: { authority: { kind: 'runtime', environmentId: 'gpu' }, selector: { kind: 'self' } },
  stableKey: 'host:runtime:gpu:self',
  label: 'GPU box',
  authorityLabel: 'GPU box',
  owner: {
    authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 4 },
    selector: { kind: 'self' }
  }
})

const RUNTIME_SSH = entry({
  stableRef: {
    authority: { kind: 'runtime', environmentId: 'gpu' },
    selector: { kind: 'ssh', targetId: 'web-01' }
  },
  stableKey: 'host:runtime:gpu:ssh:web-01',
  label: 'web-01',
  authorityLabel: 'GPU box',
  kind: 'ssh',
  owner: {
    authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 4 },
    selector: { kind: 'ssh', targetId: 'web-01', targetGeneration: 2 }
  }
})

function automation(id: string, name = id): Automation {
  return { id, name } as Automation
}

function row(id: string, owner: AutomationHostRow['owner'], name = id): AutomationHostRow {
  return {
    automation: automation(id, name),
    owner,
    selector: owner ? { kind: 'self' } : { kind: 'orphan', issue: 'missing_repo' },
    usageSummary: null,
    usageKnown: false
  }
}

function cached(rows: AutomationHostRow[], fetchedAt: number | null = 1): AutomationHostCacheEntry {
  return {
    data: rows,
    fetchedAt,
    attempt: 0,
    requestGeneration: 0,
    catalogGeneration: 0,
    request: null,
    error: null,
    orphanCount: null
  }
}

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

const ALL_HOSTS: AutomationHostFilterResolution = {
  effective: { kind: 'all' },
  entry: null,
  status: 'all',
  announceFallback: false
}

describe('automation host list rows', () => {
  it('reports nothing answered until a host has actually committed', () => {
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF]),
      resolution: ALL_HOSTS,
      entry: () => cached([], null)
    })

    // Why this matters: the caller keeps its own list while this is false, so a
    // never-answered host must not read as an empty one.
    expect(rows.answered).toBe(false)
    expect(rows.automations).toEqual([])
  })

  it('keeps the owned copy when the orphan scope returns the same record', () => {
    const owned = row('a-1', DESKTOP_SELF.owner)
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF, DESKTOP_ORPHAN]),
      resolution: ALL_HOSTS,
      entry: (stableKey) => cached(stableKey === 'host:desktop:self' ? [owned] : [row('a-1', null)])
    })

    expect(rows.automations).toHaveLength(1)
    expect(rows.capturedOwners.get(rows.rows[0]!.key)?.owner).toEqual(DESKTOP_SELF.owner)
  })

  it('keeps both authorities’ copies of one automation ID', () => {
    // An ID is unique only inside its authority (doc:38), so the desktop and a
    // runtime-owned SSH host may both hold `a-1`. Dropping either is a row the
    // user stored and can no longer see.
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF, RUNTIME_SSH]),
      resolution: ALL_HOSTS,
      entry: (stableKey) =>
        cached([
          stableKey === 'host:desktop:self'
            ? row('a-1', DESKTOP_SELF.owner, 'Nightly desktop')
            : row('a-1', RUNTIME_SSH.owner, 'Nightly web-01')
        ])
    })

    expect(rows.automations.map((item) => item.name)).toEqual(['Nightly desktop', 'Nightly web-01'])
    // Each copy keeps its own owner: a bare-ID map would hand both rows the last host's.
    expect(rows.rows.map((item) => rows.capturedOwners.get(item.key)?.owner)).toEqual([
      DESKTOP_SELF.owner,
      RUNTIME_SSH.owner
    ])
  })

  it("carries each row's host of origin so two authorities stay distinguishable", () => {
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF, RUNTIME_SELF]),
      resolution: ALL_HOSTS,
      entry: (stableKey) =>
        cached([
          stableKey === 'host:desktop:self'
            ? row('local-1', DESKTOP_SELF.owner)
            : row('gpu-1', RUNTIME_SELF.owner)
        ])
    })

    expect(rows.rows.map((item) => [item.automation.id, item.hostLabel])).toEqual([
      ['local-1', 'This computer'],
      ['gpu-1', 'GPU box']
    ])
    expect(rows.capturedOwners.get(rows.rows[1]!.key)?.owner).toEqual(RUNTIME_SELF.owner)
    expect(rows.groups.map((group) => group.authorityKey)).toEqual([
      'authority:desktop',
      'authority:runtime:gpu'
    ])
  })

  it('applies the search to grouped rows but keeps every host on screen', () => {
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF, RUNTIME_SELF]),
      resolution: ALL_HOSTS,
      entry: (stableKey) =>
        cached([
          stableKey === 'host:desktop:self'
            ? row('local-1', DESKTOP_SELF.owner)
            : row('gpu-1', RUNTIME_SELF.owner)
        ])
    })
    const visible = rows.rows
      .filter((item) => item.automation.id === 'gpu-1')
      .map((item) => item.key)
    const filtered = filterAutomationHostGroups(rows.groups, new Set(visible))

    // Why every host survives: a query hiding a host's rows is not the host going away.
    expect(filtered).toHaveLength(2)
    expect(filtered[0].hosts[0].rows).toEqual([])
    expect(filtered[1].hosts[0].rows.map((item) => item.automation.id)).toEqual(['gpu-1'])
  })

  it('renders one host without group headers', () => {
    const rows = resolveAutomationHostListRows({
      catalog: catalogOf([DESKTOP_SELF, RUNTIME_SELF]),
      resolution: {
        effective: { kind: 'host', host: DESKTOP_SELF.stableRef },
        entry: DESKTOP_SELF,
        status: 'ready',
        announceFallback: false
      },
      entry: () => cached([row('a-1', DESKTOP_SELF.owner)])
    })

    expect(rows.groups).toEqual([])
    expect(rows.automations.map((item) => item.id)).toEqual(['a-1'])
  })
})
