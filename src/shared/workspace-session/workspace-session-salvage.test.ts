import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseWorkspaceSessionSalvaging } from './workspace-session-salvage'
import { collectSalvageDrops, salvagingArray } from '../zod-salvage'

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
  it('restores outer diagnostics after a nested collection', () => {
    const schema = salvagingArray(z.string())
    const outer = collectSalvageDrops(() => {
      schema.parse([1])
      const inner = collectSalvageDrops(() => schema.parse([2]))
      schema.parse([3])
      return inner
    })

    expect(outer.droppedCount).toBe(2)
    expect(outer.value.droppedCount).toBe(1)
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

  it('drops the containing entry when the corruption sits in one of its required fields', () => {
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
      // Count distinct corrupt entries, the smallest self-contained units, rather than validation symptoms.
      expect(result.droppedPaths).toEqual(['terminalLayoutsByTabId.tab-bad'])
      expect(result.value.terminalLayoutsByTabId['tab-bad']).toBeUndefined()
      expect(result.value.terminalLayoutsByTabId['tab-good']?.root).toEqual({
        type: 'leaf',
        leafId: 'leaf-1'
      })
    }
  })

  it('reports a dotted map key and its same-named nested path independently', () => {
    // User-data key a.root differs from nested path a → root even though their rendered paths match.
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        terminalLayoutsByTabId: {
          'a.root': 'not-an-object',
          a: { root: 42, activeLeafId: null, expandedLeafId: null }
        }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths.toSorted()).toEqual([
        'terminalLayoutsByTabId.a',
        'terminalLayoutsByTabId.a.root'
      ])
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

  it('salvages rather than throwing on a payload large enough to overflow the validator', () => {
    // An escaping RangeError in Store construction prevents launch; per-entry salvage avoids materializing the old overflowing issue list.
    const worktreeId = 'repo-1::/huge'
    const tabs = Array.from({ length: 200_000 }, (_, i) => ({ id: `bad-${i}` }))
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ tabsByWorktree: { [worktreeId]: tabs } })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedCount).toBe(200_000)
      expect(result.droppedPaths).toHaveLength(100)
      expect(result.value.tabsByWorktree[worktreeId]).toEqual([])
    }
  })

  it('drops an optional top-level field whose value is the wrong type', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ terminalTopologyRevisionByRepoId: 'nope' })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual(['terminalTopologyRevisionByRepoId'])
      expect(result.value.terminalTopologyRevisionByRepoId).toBeUndefined()
      // An explicit undefined would shadow defaults in callers’ object spread.
      expect(Object.hasOwn(result.value, 'terminalTopologyRevisionByRepoId')).toBe(false)
    }
  })

  it('salvages systemic corruption far larger than any single-entry budget', () => {
    // Bad writers can corrupt many entries; do not reset the whole session when dropped counts exceed the diagnostic budget.
    const incarnations: Record<string, unknown> = {}
    for (let i = 0; i < 400; i += 1) {
      incarnations[`tab-${i}:leaf-${i}`] = i % 2 === 0 ? i : `inc-${i}`
    }
    const result = parseWorkspaceSessionSalvaging(
      baseSession({ terminalPtyIncarnationsByPaneKey: incarnations })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedCount).toBe(200)
      expect(result.droppedPaths).toHaveLength(100)
      expect(Object.keys(result.value.terminalPtyIncarnationsByPaneKey ?? {})).toHaveLength(200)
    }
  })

  it('keeps the rest of the session when a required top-level field is unsalvageable', () => {
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: 'nope',
        activeRepoId: 42,
        terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 'inc-1' }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths.toSorted()).toEqual(['activeRepoId', 'tabsByWorktree'])
      expect(result.value.tabsByWorktree).toEqual({})
      expect(result.value.activeRepoId).toBeNull()
      expect(result.value.terminalPtyIncarnationsByPaneKey).toEqual({ 'tab-1:leaf-1': 'inc-1' })
    }
  })

  it('drops a whole layout entry when the corruption sits inside a recursive union', () => {
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

  it('drops a recursive entry whose validator overflows instead of resetting the session', () => {
    let layout: Record<string, unknown> = { type: 'leaf', groupId: 'group-deep' }
    for (let depth = 0; depth < 3_000; depth += 1) {
      layout = {
        type: 'split',
        direction: 'horizontal',
        first: layout,
        second: { type: 'leaf', groupId: `group-${depth}` }
      }
    }
    const result = parseWorkspaceSessionSalvaging(
      baseSession({
        tabsByWorktree: { [WT]: [terminalTab('tab-keep')] },
        tabGroupLayouts: { [WT]: layout }
      })
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.droppedPaths).toEqual([`tabGroupLayouts.${WT}`])
      expect(result.value.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-keep'])
      expect(result.value.tabGroupLayouts).toEqual({})
    }
  })
})
