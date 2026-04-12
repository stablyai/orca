import { describe, it, expect } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/types'
import {
  findTabAndWorktree,
  findGroupForTab,
  ensureGroup,
  pickNeighbor,
  updateGroup,
  patchTab
} from './tabs-helpers'

function makeTab(overrides: Partial<Tab> & { id: string; worktreeId: string }): Tab {
  return {
    groupId: 'g1',
    contentType: 'terminal',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

describe('findTabAndWorktree', () => {
  it('finds a tab across worktrees', () => {
    const tabs: Record<string, Tab[]> = {
      w1: [makeTab({ id: 't1', worktreeId: 'w1' })],
      w2: [makeTab({ id: 't2', worktreeId: 'w2' })]
    }
    const result = findTabAndWorktree(tabs, 't2')
    expect(result).not.toBeNull()
    expect(result!.worktreeId).toBe('w2')
    expect(result!.tab.id).toBe('t2')
  })

  it('returns null for unknown tab', () => {
    expect(findTabAndWorktree({}, 'missing')).toBeNull()
  })
})

describe('findGroupForTab', () => {
  it('finds a group by worktree and groupId', () => {
    const group: TabGroup = { id: 'g1', worktreeId: 'w1', activeTabId: null, tabOrder: [] }
    const groups: Record<string, TabGroup[]> = { w1: [group] }
    expect(findGroupForTab(groups, 'w1', 'g1')).toBe(group)
  })

  it('returns null for missing group', () => {
    expect(findGroupForTab({}, 'w1', 'g1')).toBeNull()
  })
})

describe('ensureGroup', () => {
  it('returns existing group if one exists', () => {
    const group: TabGroup = { id: 'g1', worktreeId: 'w1', activeTabId: null, tabOrder: [] }
    const groups = { w1: [group] }
    const active = { w1: 'g1' }
    const result = ensureGroup(groups, active, 'w1')
    expect(result.group).toBe(group)
    expect(result.groupsByWorktree).toBe(groups)
  })

  it('creates a new group for a new worktree', () => {
    const result = ensureGroup({}, {}, 'w1')
    expect(result.group.worktreeId).toBe('w1')
    expect(result.group.tabOrder).toEqual([])
    expect(result.groupsByWorktree.w1).toHaveLength(1)
    expect(result.activeGroupIdByWorktree.w1).toBe(result.group.id)
  })
})

describe('pickNeighbor', () => {
  it('picks right neighbor first', () => {
    expect(pickNeighbor(['a', 'b', 'c'], 'b')).toBe('c')
  })

  it('falls back to left neighbor when closing rightmost', () => {
    expect(pickNeighbor(['a', 'b', 'c'], 'c')).toBe('b')
  })

  it('returns null for single item', () => {
    expect(pickNeighbor(['a'], 'a')).toBeNull()
  })

  it('returns null for missing item', () => {
    expect(pickNeighbor(['a', 'b'], 'x')).toBeNull()
  })
})

describe('updateGroup', () => {
  it('replaces the matching group', () => {
    const g1: TabGroup = { id: 'g1', worktreeId: 'w1', activeTabId: null, tabOrder: [] }
    const g2: TabGroup = { id: 'g2', worktreeId: 'w1', activeTabId: null, tabOrder: [] }
    const updated: TabGroup = { ...g1, activeTabId: 't1' }
    const result = updateGroup([g1, g2], updated)
    expect(result[0].activeTabId).toBe('t1')
    expect(result[1]).toBe(g2)
  })
})

describe('patchTab', () => {
  it('updates a single tab property', () => {
    const tabs: Record<string, Tab[]> = {
      w1: [makeTab({ id: 't1', worktreeId: 'w1', label: 'old' })]
    }
    const result = patchTab(tabs, 't1', { label: 'new' })
    expect(result).not.toBeNull()
    expect(result!.unifiedTabsByWorktree.w1[0].label).toBe('new')
  })

  it('updates multiple properties at once', () => {
    const tabs: Record<string, Tab[]> = {
      w1: [makeTab({ id: 't1', worktreeId: 'w1' })]
    }
    const result = patchTab(tabs, 't1', { isPinned: true, isPreview: false })
    expect(result).not.toBeNull()
    expect(result!.unifiedTabsByWorktree.w1[0].isPinned).toBe(true)
    expect(result!.unifiedTabsByWorktree.w1[0].isPreview).toBe(false)
  })

  it('returns null for unknown tab', () => {
    expect(patchTab({}, 'missing', { label: 'x' })).toBeNull()
  })

  it('does not modify other tabs', () => {
    const tabs: Record<string, Tab[]> = {
      w1: [
        makeTab({ id: 't1', worktreeId: 'w1', label: 'a' }),
        makeTab({ id: 't2', worktreeId: 'w1', label: 'b' })
      ]
    }
    const result = patchTab(tabs, 't1', { label: 'changed' })
    expect(result!.unifiedTabsByWorktree.w1[1].label).toBe('b')
  })
})
