import { describe, expect, it } from 'vitest'
import type {
  AutomationExecutionHealth,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import {
  resolveAutomationHostGroupEmptyState,
  resolveAutomationListEmptyState,
  type AutomationListEmptyStateInput,
  type AutomationListHostGroupEmptyStateInput
} from './automation-list-empty-state'

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
    owner: null,
    stableKey: 'host:desktop:ssh:t1',
    label: 'web-01',
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function hostResolution(
  overrides: Partial<AutomationHostFilterResolution> = {}
): AutomationHostFilterResolution {
  const resolved = overrides.entry === undefined ? entry() : overrides.entry
  return {
    effective: { kind: 'host', host: (resolved ?? entry()).stableRef },
    entry: resolved,
    status: 'ready',
    announceFallback: false,
    ...overrides
  }
}

function input(
  overrides: Partial<AutomationListEmptyStateInput> = {}
): AutomationListEmptyStateInput {
  return {
    resolution: hostResolution(),
    hostRowCount: 0,
    visibleRowCount: 0,
    searchActive: false,
    ...overrides
  }
}

/** The grouped All-hosts view: one host, its own counts, no selection to resolve. */
function groupInput(
  overrides: Partial<AutomationListHostGroupEmptyStateInput> = {}
): AutomationListHostGroupEmptyStateInput {
  return {
    entry: entry(),
    hostRowCount: 0,
    visibleRowCount: 0,
    searchActive: false,
    ...overrides
  }
}

const ALL_HOSTS: AutomationHostFilterResolution = {
  effective: { kind: 'all' },
  entry: null,
  status: 'all',
  announceFallback: false
}

describe('automation list empty state', () => {
  it('renders nothing when rows are visible', () => {
    expect(resolveAutomationListEmptyState(input({ visibleRowCount: 3 })).kind).toBe('rows')
  })

  it('uses the single-host empty string only for a healthy, connected, authoritative host', () => {
    const state = resolveAutomationListEmptyState(input())
    expect(state.kind).toBe('host-empty')
    expect(state.title).toBe('No automations on web-01')
  })

  it('uses the all-hosts string only under All hosts', () => {
    const state = resolveAutomationListEmptyState(input({ resolution: ALL_HOSTS }))
    expect(state.kind).toBe('all-hosts-empty')
    expect(state.title).toBe('No automations across loaded hosts')
  })

  it('uses the search string only when the host has rows the query hid', () => {
    const state = resolveAutomationListEmptyState(
      input({ searchActive: true, hostRowCount: 5, visibleRowCount: 0 })
    )
    expect(state.kind).toBe('search-no-match')
    expect(state.title).toBe('No automations match your search')
  })

  it('does not claim a search miss when the host itself has no rows', () => {
    const state = resolveAutomationListEmptyState(
      input({ searchActive: true, hostRowCount: 0, visibleRowCount: 0 })
    )
    expect(state.kind).toBe('host-empty')
  })

  it('uses the load-failure string when the authority could not be reached', () => {
    const state = resolveAutomationListEmptyState(
      input({
        resolution: hostResolution({
          entry: entry({ authorityHealth: 'unavailable' }),
          status: 'unavailable'
        })
      })
    )
    expect(state.kind).toBe('host-unavailable')
    expect(state.title).toBe('Automations could not be loaded from web-01')
    expect(state.recovery).toBe('reconnect')
  })

  it('offers Retry rather than Reconnect for a stale refresh', () => {
    const state = resolveAutomationListEmptyState(
      input({ resolution: hostResolution({ entry: entry({ authorityHealth: 'stale-error' }) }) })
    )
    expect(state.kind).toBe('host-error')
    expect(state.title).toBe('Automations could not be loaded from web-01')
    expect(state.recovery).toBe('retry')
  })

  it('offers Update server for an incompatible authority', () => {
    const state = resolveAutomationListEmptyState(
      input({ resolution: hostResolution({ entry: entry({ authorityHealth: 'incompatible' }) }) })
    )
    expect(state.kind).toBe('host-error')
    expect(state.recovery).toBe('update-server')
  })

  // The rule the design doc calls out explicitly.
  const NOT_CONNECTED: AutomationExecutionHealth[] = [
    'disconnected',
    'connecting',
    'unavailable',
    'unknown'
  ]
  it.each(NOT_CONNECTED)('never calls a %s host empty', (executionHealth) => {
    const state = resolveAutomationListEmptyState(
      input({ resolution: hostResolution({ entry: entry({ executionHealth }) }) })
    )
    expect(state.kind).toBe('host-not-connected')
    expect(state.title).not.toContain('No automations')
    expect(state.title).toBe('web-01 is not connected')
  })

  it('never calls an unhydrated host empty', () => {
    const state = resolveAutomationListEmptyState(
      input({
        resolution: hostResolution({
          entry: entry({ catalogState: 'unhydrated' }),
          status: 'loading'
        })
      })
    )
    expect(state.kind).toBe('host-loading')
    expect(state.title).toBe('Loading host…')
    expect(state.title).not.toContain('No automations')
  })

  it('never claims a host the group could not reach is empty', () => {
    const state = resolveAutomationHostGroupEmptyState(
      groupInput({ entry: entry({ authorityHealth: 'unavailable' }) })
    )
    expect(state.kind).toBe('host-unavailable')
    expect(state.title).toBe('Automations could not be loaded from web-01')
    expect(state.recovery).toBe('reconnect')
  })

  it.each(NOT_CONNECTED)('never calls a %s host in a group empty', (executionHealth) => {
    const state = resolveAutomationHostGroupEmptyState(
      groupInput({ entry: entry({ executionHealth }) })
    )
    expect(state.kind).toBe('host-not-connected')
    expect(state.title).not.toContain('No automations')
  })

  it('never calls an unhydrated host in a group empty', () => {
    const state = resolveAutomationHostGroupEmptyState(
      groupInput({ entry: entry({ catalogState: 'unhydrated' }) })
    )
    expect(state.kind).toBe('host-loading')
    expect(state.title).not.toContain('No automations')
  })

  it('blames the query, not the host, when a group is emptied by search', () => {
    const state = resolveAutomationHostGroupEmptyState(
      groupInput({ searchActive: true, hostRowCount: 3, visibleRowCount: 0 })
    )
    expect(state.kind).toBe('search-no-match')
    expect(state.title).toBe('No automations match your search')
  })

  it('still renders rows for a group whose host answered with some', () => {
    expect(resolveAutomationHostGroupEmptyState(groupInput({ visibleRowCount: 2 })).kind).toBe(
      'rows'
    )
  })

  it('calls a healthy, connected, authoritative group host empty', () => {
    const state = resolveAutomationHostGroupEmptyState(groupInput())
    expect(state.kind).toBe('host-empty')
    expect(state.title).toBe('No automations on web-01')
  })

  it('keeps each empty string exclusive to its own condition', () => {
    const titles = [
      resolveAutomationListEmptyState(input()).title,
      resolveAutomationListEmptyState(input({ resolution: ALL_HOSTS })).title,
      resolveAutomationListEmptyState(input({ searchActive: true, hostRowCount: 2 })).title,
      resolveAutomationListEmptyState(
        input({ resolution: hostResolution({ entry: entry({ authorityHealth: 'stale-error' }) }) })
      ).title
    ]
    expect(new Set(titles).size).toBe(4)
  })
})
