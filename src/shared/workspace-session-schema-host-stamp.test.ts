import { describe, expect, it } from 'vitest'
import { parseWorkspaceSessionSalvaging } from './workspace-session-salvage'

const WT = 'repo1::/path/wt1'

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function parsedEntries(entries: Record<string, unknown>[]) {
  const result = parseWorkspaceSessionSalvaging(
    JSON.parse(
      JSON.stringify({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { [WT]: entries }
      })
    )
  )
  if (!result.ok) {
    throw new Error(`session did not parse: ${result.error}`)
  }
  return { tabs: result.value.unifiedTabs?.[WT] ?? [], droppedCount: result.droppedCount }
}

describe('workspace session schema: a cross-host terminal stamp', () => {
  it.each([['setup-1'], [42], [null], [''], ['  '], [{ id: 'setup-1' }]])(
    'keeps a setup value %j verbatim beside its host',
    (setup) => {
      const { tabs, droppedCount } = parsedEntries([
        entry({ executionHostId: 'runtime:env-a', projectHostSetupId: setup })
      ])
      expect(droppedCount).toBe(0)
      expect(tabs).toHaveLength(1)
      expect(tabs[0]).toHaveProperty('projectHostSetupId', setup)
      expect(tabs[0]?.executionHostId).toBe('runtime:env-a')
    }
  )

  it('leaves an entry with no setup key without one', () => {
    const { tabs } = parsedEntries([entry({ executionHostId: 'runtime:env-a' })])
    expect(tabs[0]).not.toHaveProperty('projectHostSetupId')
  })

  it.each([['bogus'], [42], [null], ['runtime:'], [{ id: 'runtime:env-a' }]])(
    'keeps a stamped entry whose host %j is unreadable, dropping only that host',
    (host) => {
      const { tabs, droppedCount } = parsedEntries([
        entry({ executionHostId: host, projectHostSetupId: 42, label: 'Builder' })
      ])
      expect(droppedCount).toBe(0)
      expect(tabs).toHaveLength(1)
      expect(tabs[0]).not.toHaveProperty('executionHostId')
      expect(tabs[0]).toMatchObject({ id: 'tab-1', projectHostSetupId: 42, label: 'Builder' })
    }
  )

  it('still drops an ordinary entry whose host is unreadable, as before', () => {
    const { tabs, droppedCount } = parsedEntries([
      entry({ executionHostId: 'bogus' }),
      entry({ id: 'tab-2', entityId: 'tab-2', executionHostId: 'local' })
    ])
    expect(droppedCount).toBe(1)
    expect(tabs.map((tab) => tab.id)).toEqual(['tab-2'])
  })

  it('still drops a stamped entry that is corrupt beyond its host', () => {
    const { tabs, droppedCount } = parsedEntries([
      entry({ executionHostId: 'bogus', projectHostSetupId: 'setup-1', label: 7 })
    ])
    expect(droppedCount).toBe(1)
    expect(tabs).toEqual([])
  })
})
