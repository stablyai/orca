import { describe, expect, it } from 'vitest'
import { parseWorkspaceSessionSalvaging } from './workspace-session-salvage'

const WT = 'repo-1::/home/user/project'

function terminalTab(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: WT,
    title: 'Terminal',
    defaultTitle: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function baseSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

describe('parseWorkspaceSessionSalvaging', () => {
  it('returns a valid session unchanged with nothing dropped', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ tabsByWorktree: { [WT]: [terminalTab('tab-1')] } })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual([])
      expect(result.value.tabsByWorktree[WT]).toHaveLength(1)
    }
  })

  it('drops a tab record missing required fields and keeps the rest of the session', () => {
    const truncated = {
      id: 'tab-bad',
      ptyId: null,
      worktreeId: WT,
      title: 'Terminal',
      sortOrder: 0,
      generation: 3,
      startupCwd: '/home/user/project'
    }
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: { [WT]: [terminalTab('tab-1'), terminalTab('tab-2'), truncated] },
        sleepingAgentSessionsByPaneKey: {}
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual([`tabsByWorktree.${WT}.2`])
      expect(result.value.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
    }
  })

  it('drops only the corrupt leaf pty mapping and keeps the rest of the tab layout', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: { [WT]: [terminalTab('tab-1')] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 42 }
          }
        }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual(['terminalLayoutsByTabId.tab-1.ptyIdsByLeafId.leaf-2'])
      const layout = result.value.terminalLayoutsByTabId['tab-1']
      expect(layout?.ptyIdsByLeafId).toEqual({ 'leaf-1': 'pty-1' })
      expect(layout?.root).toEqual({ type: 'leaf', leafId: 'leaf-1' })
    }
  })

  it('escalates to the containing entry when dropping a leaf leaves a required field missing', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        terminalLayoutsByTabId: {
          'tab-bad': {
            root: { type: 'leaf', leafId: 42 },
            activeLeafId: null,
            expandedLeafId: null
          },
          'tab-good': {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null
          }
        }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Why: the escalated repair reports only the final self-contained entry it
      // removed, so dropped counts reflect distinct corrupt records.
      expect(result.droppedPaths).toEqual(['terminalLayoutsByTabId.tab-bad'])
      expect(result.value.terminalLayoutsByTabId['tab-bad']).toBeUndefined()
      expect(result.value.terminalLayoutsByTabId['tab-good']?.root).toEqual({
        type: 'leaf',
        leafId: 'leaf-1'
      })
    }
  })

  it('salvages systemic single-field corruption without inflating the dropped count', () => {
    // Why: each two-step escalation (drop the field, then its emptied parent) is
    // one repair, so dropped counts reflect distinct corrupt records.
    const layouts: Record<string, unknown> = {}
    for (let i = 0; i < 20; i += 1) {
      layouts[`tab-${i}`] = {
        root: { type: 'leaf', leafId: i },
        activeLeafId: null,
        expandedLeafId: null
      }
    }
    const result = parseWorkspaceSessionSalvaging(baseSession({ terminalLayoutsByTabId: layouts }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.terminalLayoutsByTabId).toEqual({})
      expect(result.droppedPaths).toHaveLength(20)
    }
  })

  it('does not treat an unrelated corruption at a dot-colliding key as a free escalation', () => {
    // Why: 'a.root' (one key containing a dot) and 'a' → missing 'root' produce
    // paths that collide when joined with '.'; segment-wise comparison must keep
    // them as two distinct repairs rather than one posing as the other's escalation.
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        terminalLayoutsByTabId: {
          'a.root': 'not-an-object',
          a: { activeLeafId: null, expandedLeafId: null }
        }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toHaveLength(2)
      expect(result.value.terminalLayoutsByTabId).toEqual({})
    }
  })

  it('drops an invalid unified tab entry without touching sibling worktrees', () => {
    const goodUnified = {
      id: 'tab-1',
      entityId: 'tab-1',
      groupId: 'group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1_700_000_000_000
    }
    const missingCustomLabel = { ...goodUnified, id: 'tab-2', entityId: 'tab-2' } as Record<
      string,
      unknown
    >
    delete missingCustomLabel.customLabel
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: { [WT]: [terminalTab('tab-1')] },
        unifiedTabs: { [WT]: [goodUnified, missingCustomLabel], 'repo-2::/other': [] }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual([`unifiedTabs.${WT}.1`])
      expect(result.value.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['tab-1'])
      expect(result.value.unifiedTabs?.['repo-2::/other']).toEqual([])
    }
  })

  it('drops a corrupt map value by its key', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 'inc-1', 'tab-2:leaf-2': 123 }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual(['terminalPtyIncarnationsByPaneKey.tab-2:leaf-2'])
      expect(result.value.terminalPtyIncarnationsByPaneKey).toEqual({ 'tab-1:leaf-1': 'inc-1' })
    }
  })

  it('salvages multiple corrupt entries across different maps in one pass', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: { [WT]: [terminalTab('tab-1'), { id: 'tab-bad' }] },
        terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 42 }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toHaveLength(2)
      expect(result.value.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-1'])
    }
  })

  it('reports unsalvageable instead of throwing when the validator overflows', () => {
    // Why: zod materializes an issue per bad field; a payload with hundreds of
    // thousands of them blows the stack. This parse runs in the Store
    // constructor, so an escaping RangeError is an unrecoverable launch failure.
    const worktreeId = 'repo-1::/huge'
    const tabs = Array.from({ length: 200_000 }, (_, i) => ({ id: `bad-${i}` }))
    expect(() =>
      parseWorkspaceSessionSalvaging(baseSession({ tabsByWorktree: { [worktreeId]: tabs } }))
    ).not.toThrow()
    expect(
      parseWorkspaceSessionSalvaging(baseSession({ tabsByWorktree: { [worktreeId]: tabs } })).ok
    ).toBe(false)
  })

  it('fails for a payload that is not an object', () => {
    const result = parseWorkspaceSessionSalvaging('not a session')
    expect(result.ok).toBe(false)
  })

  it('fails when a required top-level field cannot be salvaged', () => {
    const result = parseWorkspaceSessionSalvaging(baseSession({ tabsByWorktree: 'nope' }))
    expect(result.ok).toBe(false)
  })

  it('drops an optional top-level field whose value is the wrong type', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ terminalTopologyRevisionByRepoId: 'nope' })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual(['terminalTopologyRevisionByRepoId'])
      expect(result.value.terminalTopologyRevisionByRepoId).toBeUndefined()
    }
  })

  it('salvages systemic corruption far larger than any single-entry budget', () => {
    // Why: the reported failure was one bad record, but a bad writer projects the
    // same wrong shape across every tab it touches. Dropping every entry zod
    // reports per pass keeps that case a salvage instead of a full-session reset.
    const incarnations: Record<string, unknown> = {}
    for (let i = 0; i < 400; i += 1) {
      incarnations[`tab-${i}:leaf-${i}`] = i % 2 === 0 ? i : `inc-${i}`
    }
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ terminalPtyIncarnationsByPaneKey: incarnations })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toHaveLength(200)
      expect(Object.keys(result.value.terminalPtyIncarnationsByPaneKey ?? {})).toHaveLength(200)
    }
  })

  it('drops many corrupt tab records across worktrees in a single session load', () => {
    const tabsByWorktree: Record<string, unknown> = {}
    for (let w = 0; w < 20; w += 1) {
      const worktreeId = `repo-1::/w${w}`
      tabsByWorktree[worktreeId] = [
        terminalTab(`good-${w}`, { worktreeId }),
        { id: `bad-a-${w}`, worktreeId },
        terminalTab(`good2-${w}`, { worktreeId }),
        { id: `bad-b-${w}`, worktreeId }
      ]
    }
    const result = parseWorkspaceSessionSalvaging(baseSession({ tabsByWorktree }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toHaveLength(40)
      expect(result.value.tabsByWorktree['repo-1::/w7']?.map((tab) => tab.id)).toEqual([
        'good-7',
        'good2-7'
      ])
    }
  })

  it('keeps the rest of the session when a required top-level field is unsalvageable', () => {
    // Why: without a default to fall back on, one bad legacy `tabsByWorktree`
    // would still cost every worktree's unified tabs, groups and layouts.
    const defaults = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as unknown as Parameters<typeof parseWorkspaceSessionSalvaging>[1]
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: 'nope',
        terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 'inc-1' }
      }),
      defaults
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual(['tabsByWorktree'])
      expect(result.value.tabsByWorktree).toEqual({})
      expect(result.value.terminalPtyIncarnationsByPaneKey).toEqual({ 'tab-1:leaf-1': 'inc-1' })
    }
  })

  it('still rejects a foreign object payload even when defaults are available', () => {
    // Why: defaults must repair fields this module dropped, never manufacture a
    // session out of an unrelated JSON blob that simply lacks every field.
    const defaults = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as unknown as Parameters<typeof parseWorkspaceSessionSalvaging>[1]
    const result = parseWorkspaceSessionSalvaging({ unrelated: 'payload', count: 3 }, defaults)
    expect(result.ok).toBe(false)
  })

  it('drops a whole layout entry when the corruption sits inside a recursive union', () => {
    // Why: zod reports a union failure at the union's own path, so the salvage
    // granularity for a corrupt split tree is the containing map entry.
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabGroupLayouts: {
          [WT]: {
            type: 'split',
            direction: 'row',
            first: { type: 'split', direction: 'column', first: { type: 'leaf', groupId: 42 } }
          },
          'repo-2::/other': { type: 'leaf', groupId: 'group-ok' }
        }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual([`tabGroupLayouts.${WT}`])
      expect(result.value.tabGroupLayouts?.[WT]).toBeUndefined()
      expect(result.value.tabGroupLayouts?.['repo-2::/other']).toBeDefined()
    }
  })
})
