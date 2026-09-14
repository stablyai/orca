import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  resetActiveTerminalChromeStateSelectorCacheForTest,
  selectActiveTerminalChromeState
} from './active-terminal-chrome-selector'

function terminalTab(id: string, worktreeId = 'wt-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('selectActiveTerminalChromeState', () => {
  beforeEach(() => {
    resetActiveTerminalChromeStateSelectorCacheForTest()
  })

  it('reuses the projection for stable inputs across selector fanout', () => {
    const tabs = [terminalTab('tab-1')]
    const state = {
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabsByWorktree: { 'wt-1': tabs },
      canExpandPaneByTabId: { 'tab-1': true },
      expandedPaneByTabId: { 'tab-1': false }
    } satisfies Parameters<typeof selectActiveTerminalChromeState>[0]

    const first = selectActiveTerminalChromeState(state)
    let distinctResults = 0
    let previous = first
    const iterations = 100_000
    for (let index = 0; index < iterations; index += 1) {
      const selected = selectActiveTerminalChromeState(state)
      if (selected !== previous) {
        distinctResults += 1
      }
      previous = selected
    }

    expect(distinctResults).toBe(0)
    expect(previous).toBe(first)
  })

  it('reuses equivalent replacement inputs and invalidates visible scalar changes', () => {
    const tabs = [terminalTab('tab-1')]
    const state = {
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: { 'wt-1': tabs },
      canExpandPaneByTabId: { 'tab-1': false },
      expandedPaneByTabId: { 'tab-1': false }
    } satisfies Parameters<typeof selectActiveTerminalChromeState>[0]

    const first = selectActiveTerminalChromeState(state)
    const equivalentReplacement = selectActiveTerminalChromeState({
      ...state,
      tabsByWorktree: { 'wt-1': tabs.map((tab) => ({ ...tab, title: 'new title' })) },
      canExpandPaneByTabId: { 'tab-1': false },
      expandedPaneByTabId: { 'tab-1': false }
    })
    expect(equivalentReplacement).toBe(first)

    const afterActiveTabId = selectActiveTerminalChromeState({
      ...state,
      activeTabId: 'tab-1'
    })
    expect(afterActiveTabId).not.toBe(first)

    const afterActiveWorktreeId = selectActiveTerminalChromeState({
      ...state,
      activeWorktreeId: 'wt-2',
      tabsByWorktree: { 'wt-2': tabs }
    })
    expect(afterActiveWorktreeId).not.toBe(afterActiveTabId)

    const afterEffectiveActiveTabId = selectActiveTerminalChromeState({
      ...state,
      tabsByWorktree: { 'wt-1': [terminalTab('tab-2')] }
    })
    expect(afterEffectiveActiveTabId).not.toBe(afterActiveWorktreeId)
    expect(afterEffectiveActiveTabId.effectiveActiveTabId).toBe('tab-2')

    const afterCanExpand = selectActiveTerminalChromeState({
      ...state,
      canExpandPaneByTabId: { 'tab-1': true }
    })
    expect(afterCanExpand).not.toBe(afterEffectiveActiveTabId)
    expect(afterCanExpand.activeTabCanExpand).toBe(true)

    const afterExpanded = selectActiveTerminalChromeState({
      ...state,
      canExpandPaneByTabId: { 'tab-1': true },
      expandedPaneByTabId: { 'tab-1': true }
    })
    expect(afterExpanded).not.toBe(afterCanExpand)
    expect(afterExpanded.effectiveActiveTabExpanded).toBe(true)

    const afterTabCount = selectActiveTerminalChromeState({
      ...state,
      tabsByWorktree: {
        'wt-1': [...tabs, terminalTab('tab-2')]
      }
    })
    expect(afterTabCount).not.toBe(afterExpanded)
    expect(afterTabCount.tabCount).toBe(2)
  })
})
