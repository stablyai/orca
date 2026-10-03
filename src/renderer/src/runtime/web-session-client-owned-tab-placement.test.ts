import { describe, expect, it } from 'vitest'
import type { TabGroup } from '../../../shared/tab-types'
import { reconcileClientOwnedTabPlacement } from './web-session-client-owned-tab-placement'
import type { ClientOwnedPlacementInput } from './web-session-client-owned-tab-placement'

const pane: TabGroup = {
  id: 'pane',
  worktreeId: 'wt',
  activeTabId: 'a',
  tabOrder: ['a', 'b', 'x'],
  recentTabIds: ['x', 'b', 'a'],
  tabClusters: [
    {
      id: 'work',
      name: 'Work',
      color: 'blue',
      collapsed: true,
      tabIds: ['a', 'b'],
      shownTabId: 'a'
    }
  ]
}
const input: ClientOwnedPlacementInput = {
  currentGroups: [pane],
  worktreeId: 'wt',
  validUnifiedTabIds: new Set(['b', 'x']),
  adoptedTabs: [],
  placementMoves: [],
  rekeyedTabIds: new Map(),
  intentTabId: null,
  reservedEmptyGroupFallbackTabId: null,
  currentActiveGroupId: pane.id,
  currentLayout: { type: 'leaf', groupId: pane.id },
  isGroupReserved: () => false
}

describe('client-owned snapshot close successors', () => {
  it('prefers a visible survivor over a hidden MRU member when the sticky active tab vanishes', () => {
    const result = reconcileClientOwnedTabPlacement(input)

    expect(result.groups?.[0]?.tabOrder).toEqual(['b', 'x'])
    expect(result.groups?.[0]?.activeTabId).toBe('x')
    expect(result.groups?.[0]?.recentTabIds).toEqual(['b', 'x'])
    expect(result.activeGroupId).toBe(pane.id)
  })

  it('skips hidden neighbors when the active tab is the only recorded visit', () => {
    const result = reconcileClientOwnedTabPlacement({
      ...input,
      currentGroups: [{ ...pane, recentTabIds: ['a'] }]
    })

    expect(result.groups?.[0]?.activeTabId).toBe('x')
    expect(result.groups?.[0]?.recentTabIds).toEqual(['x'])
  })

  it('still activates a hidden member when no visible tab survives', () => {
    const result = reconcileClientOwnedTabPlacement({
      ...input,
      validUnifiedTabIds: new Set(['b'])
    })

    expect(result.groups?.[0]?.tabOrder).toEqual(['b'])
    expect(result.groups?.[0]?.activeTabId).toBe('b')
    expect(result.groups?.[0]?.recentTabIds).toEqual(['b'])
  })

  it('allows explicit navigation intent to activate a hidden member', () => {
    const result = reconcileClientOwnedTabPlacement({ ...input, intentTabId: 'b' })

    expect(result.groups?.[0]?.activeTabId).toBe('b')
    expect(result.groups?.[0]?.recentTabIds).toEqual(['x', 'b'])
  })

  it('preserves the ungrouped MRU successor when the active tab vanishes', () => {
    const result = reconcileClientOwnedTabPlacement({
      ...input,
      currentGroups: [{ ...pane, tabClusters: undefined }]
    })

    expect(result.groups?.[0]?.activeTabId).toBe('b')
    expect(result.groups?.[0]?.recentTabIds).toEqual(['x', 'b'])
  })
})
