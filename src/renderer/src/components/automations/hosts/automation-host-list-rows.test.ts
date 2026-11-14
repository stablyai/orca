import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationHostCacheEntry, AutomationHostRow } from './automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import { resolveAutomationHostListRows } from './automation-host-list-rows'

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
})
