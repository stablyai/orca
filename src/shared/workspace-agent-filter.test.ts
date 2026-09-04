import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceAgentIds,
  getCatalogTuiAgentIds,
  migrateLegacyFilterHarnessId,
  normalizeFilterAgentId,
  normalizeFilterAgentIds,
  resolveIncomingFilterAgentIds,
  resolvePersistedFilterAgentIds,
  toggleAllFilterAgents,
  toggleFilterAgentId,
  workspaceMatchesAgentFilter
} from './workspace-agent-filter'

const catalogIds = getCatalogTuiAgentIds()

describe('normalizeFilterAgentIds', () => {
  it('keeps catalog TuiAgent ids, drops unknowns, and collapses empty/full sets to All', () => {
    expect(normalizeFilterAgentIds(['claude', 'claude-agent-teams', 'claude'])).toEqual([
      'claude',
      'claude-agent-teams'
    ])
    expect(normalizeFilterAgentIds(['openclaude', 'cc', 'unknown'])).toEqual(['openclaude'])
    expect(normalizeFilterAgentIds([])).toBeNull()
    expect(normalizeFilterAgentIds(null)).toBeNull()
    expect(normalizeFilterAgentIds(catalogIds)).toBeNull()
  })
})

describe('migrateLegacyFilterHarnessId', () => {
  it('maps leftover harness values onto catalog agents', () => {
    expect(migrateLegacyFilterHarnessId('codex')).toBe('codex')
    expect(migrateLegacyFilterHarnessId('cc')).toBe('claude')
    expect(migrateLegacyFilterHarnessId('claude')).toBeNull()
    expect(migrateLegacyFilterHarnessId(undefined)).toBeNull()
  })
})

describe('resolvePersistedFilterAgentIds', () => {
  it('prefers a present filterAgentIds value, including explicit null', () => {
    expect(
      resolvePersistedFilterAgentIds({
        filterAgentIds: ['openclaude', 'codex'],
        filterAgentId: 'claude',
        filterHarnessId: 'cc'
      })
    ).toEqual(['openclaude', 'codex'])
    expect(
      resolvePersistedFilterAgentIds({
        filterAgentIds: null,
        filterAgentId: 'claude',
        filterHarnessId: 'cc'
      })
    ).toBeNull()
    expect(resolvePersistedFilterAgentIds({ filterAgentIds: [] })).toBeNull()
  })

  it('hydrates leftover singular filterAgentId onto a one-id list', () => {
    expect(resolvePersistedFilterAgentIds({ filterAgentId: 'openclaude' })).toEqual(['openclaude'])
    expect(resolvePersistedFilterAgentIds({ filterAgentId: 'cc' })).toBeNull()
    expect(
      resolvePersistedFilterAgentIds({ filterAgentId: null, filterHarnessId: 'cc' })
    ).toBeNull()
  })

  it('hydrates leftover cc/codex harness values when newer fields are absent', () => {
    expect(resolvePersistedFilterAgentIds({ filterHarnessId: 'cc' })).toEqual(['claude'])
    expect(resolvePersistedFilterAgentIds({ filterHarnessId: 'codex' })).toEqual(['codex'])
    expect(resolvePersistedFilterAgentIds({ filterHarnessId: 'unknown' })).toBeNull()
    expect(resolvePersistedFilterAgentIds({})).toBeNull()
  })
})

describe('resolveIncomingFilterAgentIds', () => {
  it('uses incoming filterAgentIds when present, including explicit null', () => {
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['claude'] },
        incoming: { filterAgentIds: ['openclaude'], filterAgentId: 'codex' }
      })
    ).toEqual(['openclaude'])
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['claude'] },
        incoming: { filterAgentIds: null, filterHarnessId: 'cc' }
      })
    ).toBeNull()
  })

  it('resolves leftover singular and harness-only payloads instead of the stored list', () => {
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['claude'] },
        incoming: { filterAgentId: 'openclaude' }
      })
    ).toEqual(['openclaude'])
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['openclaude'] },
        incoming: { filterHarnessId: 'cc' }
      })
    ).toEqual(['claude'])
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['openclaude'] },
        incoming: { filterHarnessId: 'codex' }
      })
    ).toEqual(['codex'])
  })

  it('keeps the stored filter when the update has no agent-filter fields', () => {
    expect(
      resolveIncomingFilterAgentIds({
        current: { filterAgentIds: ['claude', 'codex'] },
        incoming: {}
      })
    ).toEqual(['claude', 'codex'])
  })
})

describe('toggleFilterAgentId / toggleAllFilterAgents', () => {
  it('scopes from All to the clicked agent, then multi-selects', () => {
    expect(toggleFilterAgentId(null, 'claude', catalogIds)).toEqual(['claude'])
    expect(toggleFilterAgentId(['claude'], 'codex', catalogIds)).toEqual(['claude', 'codex'])
  })

  it('refuses to uncheck the last remaining agent', () => {
    expect(toggleFilterAgentId(['claude'], 'claude', catalogIds)).toEqual(['claude'])
  })

  it('collapses to All when every catalog agent is checked', () => {
    const allButLast = catalogIds.slice(0, -1)
    const last = catalogIds.at(-1)
    expect(last).toBeDefined()
    expect(toggleFilterAgentId(allButLast, last!, catalogIds)).toBeNull()
  })

  it('returns to All from the dedicated All control, and scopes to the first catalog agent from All', () => {
    expect(toggleAllFilterAgents(['claude', 'codex'], catalogIds)).toBeNull()
    expect(toggleAllFilterAgents(null, catalogIds)).toEqual([catalogIds[0]])
  })
})

describe('workspaceMatchesAgentFilter', () => {
  it('shows every workspace when the filter is All', () => {
    expect(workspaceMatchesAgentFilter(new Set(), null)).toBe(true)
    expect(workspaceMatchesAgentFilter(collectWorkspaceAgentIds(['claude']), null)).toBe(true)
  })

  it('matches any selected catalog agent (union) by exact id', () => {
    expect(workspaceMatchesAgentFilter(collectWorkspaceAgentIds(['claude']), ['claude'])).toBe(true)
    expect(
      workspaceMatchesAgentFilter(collectWorkspaceAgentIds(['claude-agent-teams']), ['claude'])
    ).toBe(false)
    expect(
      workspaceMatchesAgentFilter(collectWorkspaceAgentIds(['codex']), ['claude', 'codex'])
    ).toBe(true)
  })

  it('ignores unknown agent strings so they cannot match a catalog selection', () => {
    expect(
      workspaceMatchesAgentFilter(collectWorkspaceAgentIds(['unknown', 'cc']), ['claude'])
    ).toBe(false)
    expect(workspaceMatchesAgentFilter(new Set(), ['claude'])).toBe(false)
  })
})

describe('normalizeFilterAgentId', () => {
  it('keeps catalog TuiAgent ids and drops everything else', () => {
    expect(normalizeFilterAgentId('claude')).toBe('claude')
    expect(normalizeFilterAgentId('cc')).toBeNull()
  })
})
