import { describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { mulberry32 } from '../../../../shared/agent-tui-ansi-fuzz-stream'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { findTabAgentEntry } from '../native-chat/native-chat-tab-agent-entry'
import {
  createTabBarAgentProjectionSelector,
  selectTabBarAgentProjections,
  selectNativeChatTabWideFallbackUnsafeTabsById,
  selectTabAgentTypesByTabId
} from './tab-agent-types-by-tab-id'

function entry(partial: Partial<AgentStatusEntry>): AgentStatusEntry {
  return { state: 'working', updatedAt: 0, ...partial } as AgentStatusEntry
}

function splitLayout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    },
    activeLeafId,
    expandedLeafId: null
  }
}

describe('selectTabAgentTypesByTabId', () => {
  it('maps each tab to its first pane agent type, matching findTabAgentEntry', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' }),
      'tab-2:leaf-a': entry({ agentType: 'codex' })
    }
    const projection = selectTabAgentTypesByTabId(map)
    expect(projection).toEqual({ 'tab-1': 'claude', 'tab-2': 'codex' })

    for (const tabId of ['tab-1', 'tab-2', 'tab-missing']) {
      expect(projection[tabId] ?? null).toBe(findTabAgentEntry(map, tabId)?.agentType ?? null)
    }
  })

  it('a first pane without an agentType yields null even if a later pane has one', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: undefined }),
      'tab-1:leaf-b': entry({ agentType: 'claude' })
    }
    // Match legacy first-pane lookup even when its missing agentType masks later matching panes.
    expect(selectTabAgentTypesByTabId(map)['tab-1'] ?? null).toBe(
      findTabAgentEntry(map, 'tab-1')?.agentType ?? null
    )
  })

  it('uses the active split leaf regardless of pane-map insertion order', () => {
    const layouts = { 'tab-1': splitLayout('leaf-b') }
    const agentFirst = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' })
    }
    const activeFirst = {
      'tab-1:leaf-b': entry({ agentType: 'codex' }),
      'tab-1:leaf-a': entry({ agentType: 'claude' })
    }

    expect(selectTabAgentTypesByTabId(agentFirst, layouts)['tab-1']).toBe('codex')
    expect(selectTabAgentTypesByTabId(activeFirst, layouts)['tab-1']).toBe('codex')
    expect(selectNativeChatTabWideFallbackUnsafeTabsById(layouts)).toEqual({
      'tab-1': true
    })
  })

  it('does not inherit a supported sibling when the active split leaf is a shell', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:leaf-a': entry({ agentType: 'claude' }),
        'tab-1:leaf-b': entry({ agentType: undefined })
      },
      { 'tab-1': splitLayout('leaf-b') }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
  })

  it('uses the reassigned active sibling after the prior agent leaf closes', () => {
    const statuses = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' })
    }

    expect(
      selectTabAgentTypesByTabId(statuses, {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-b' },
          activeLeafId: 'leaf-b',
          expandedLeafId: null
        }
      })['tab-1']
    ).toBe('codex')
  })

  it('does not fall back to insertion order while a split has no active leaf', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:leaf-a': entry({ agentType: 'claude' }),
        'tab-1:leaf-b': entry({ agentType: undefined })
      },
      { 'tab-1': splitLayout(null) }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
  })

  it('ignores a stale active leaf id that is no longer in the layout', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:closed-leaf': entry({ agentType: 'claude' }),
        'tab-1:leaf-a': entry({ agentType: undefined })
      },
      {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'closed-leaf',
          expandedLeafId: null
        }
      }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
    expect(
      selectNativeChatTabWideFallbackUnsafeTabsById({
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'closed-leaf',
          expandedLeafId: null
        }
      })
    ).toEqual({ 'tab-1': true })
  })

  it('uses the pane entry while a rootless layout is still hydrating', () => {
    expect(
      selectTabAgentTypesByTabId(
        { 'tab-1:leaf-a': entry({ agentType: 'claude' }) },
        { 'tab-1': { root: null, activeLeafId: null, expandedLeafId: null } }
      )
    ).toEqual({ 'tab-1': 'claude' })
  })

  it('treats a missing layout map as no unsafe split evidence during hydration', () => {
    expect(selectNativeChatTabWideFallbackUnsafeTabsById()).toEqual({})
  })

  it('resolves the active leaf through nested splits and ignores expanded siblings', () => {
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-b' },
          second: { type: 'leaf', leafId: 'leaf-c' }
        }
      },
      activeLeafId: 'leaf-c',
      expandedLeafId: 'leaf-a'
    }

    expect(
      selectTabAgentTypesByTabId(
        {
          'tab-1:leaf-a': entry({ agentType: 'claude' }),
          'tab-1:leaf-c': entry({ agentType: 'codex' })
        },
        { 'tab-1': layout }
      )
    ).toEqual({ 'tab-1': 'codex' })
  })

  it('stays shallow-equal across a working<->idle status flip (no re-render)', () => {
    const working: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'working' })
    }
    // A status write replaces the entry object but not the agentType.
    const done: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'done' })
    }
    expect(shallow(selectTabAgentTypesByTabId(working), selectTabAgentTypesByTabId(done))).toBe(
      true
    )
  })

  it('shallow-changes when a tab gains or changes its agent', () => {
    const before = selectTabAgentTypesByTabId({
      'tab-1:leaf-a': entry({ agentType: 'claude' })
    })
    const gained = selectTabAgentTypesByTabId({
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-2:leaf-a': entry({ agentType: 'codex' })
    })
    expect(shallow(before, gained)).toBe(false)
  })

  it('ignores malformed pane keys with no tab id', () => {
    expect(selectTabAgentTypesByTabId({ ':leaf-a': entry({ agentType: 'claude' }) })).toEqual({})
  })

  it('shares one pair of global scans across retained TabBar consumers', () => {
    const onStatusEntryVisited = vi.fn()
    const onAgentTypeLayoutVisited = vi.fn()
    const onUnsafeLayoutVisited = vi.fn()
    const select = createTabBarAgentProjectionSelector({
      onStatusEntryVisited,
      onAgentTypeLayoutVisited,
      onUnsafeLayoutVisited
    })
    const statuses = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-2:leaf-a': entry({ agentType: 'codex' }),
      'tab-3:leaf-a': entry({ agentType: 'grok' })
    }
    const layouts = {
      'tab-1': splitLayout('leaf-a'),
      'tab-2': splitLayout('leaf-a')
    }

    for (let consumer = 0; consumer < 100; consumer++) {
      select({
        agentStatusByPaneKey: statuses,
        terminalLayoutsByTabId: layouts
      })
    }

    expect(onStatusEntryVisited).toHaveBeenCalledTimes(3)
    expect(onAgentTypeLayoutVisited).toHaveBeenCalledTimes(2)
    expect(onUnsafeLayoutVisited).toHaveBeenCalledTimes(2)
  })

  it('reuses outputs and invalidates only the projection whose input changed', () => {
    const onStatusEntryVisited = vi.fn()
    const onStatusComparisonVisited = vi.fn()
    const onLayoutComparisonVisited = vi.fn()
    const onAgentTypeLayoutVisited = vi.fn()
    const onUnsafeLayoutVisited = vi.fn()
    const select = createTabBarAgentProjectionSelector({
      onStatusEntryVisited,
      onStatusComparisonVisited,
      onLayoutComparisonVisited,
      onAgentTypeLayoutVisited,
      onUnsafeLayoutVisited
    })
    const split = { 'tab-1': splitLayout('leaf-a') }
    const working = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'working' }),
      'tab-1:leaf-b': entry({ agentType: 'codex', state: 'working' })
    }

    const first = select({
      agentStatusByPaneKey: working,
      terminalLayoutsByTabId: split
    })
    const done = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'done' }),
      'tab-1:leaf-b': entry({ agentType: 'codex', state: 'done' })
    }
    const afterStatus = select({
      agentStatusByPaneKey: done,
      terminalLayoutsByTabId: split
    })

    expect(afterStatus).toBe(first)
    // Same-key pings that keep each agent cost one status comparison and no projection walks.
    expect(onStatusComparisonVisited).toHaveBeenCalledTimes(2)
    expect(onLayoutComparisonVisited).toHaveBeenCalledTimes(1)
    expect(onStatusEntryVisited).toHaveBeenCalledTimes(2)
    expect(onAgentTypeLayoutVisited).toHaveBeenCalledTimes(1)
    expect(onUnsafeLayoutVisited).toHaveBeenCalledTimes(1)

    const singleLeaf = {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null
      }
    }
    const afterLayout = select({
      agentStatusByPaneKey: done,
      terminalLayoutsByTabId: singleLeaf
    })

    expect(afterLayout.tabAgentTypesByTabId).toEqual({ 'tab-1': 'codex' })
    expect(afterLayout.tabAgentTypesByTabId).not.toBe(first.tabAgentTypesByTabId)
    expect(afterLayout.nativeChatTabWideFallbackUnsafeTabsById).toEqual({})
    expect(afterLayout.nativeChatTabWideFallbackUnsafeTabsById).not.toBe(
      first.nativeChatTabWideFallbackUnsafeTabsById
    )
    // Only the edited tab is re-resolved; its layout claims it, so no first-pane status walk.
    expect(onStatusComparisonVisited).toHaveBeenCalledTimes(2)
    expect(onLayoutComparisonVisited).toHaveBeenCalledTimes(2)
    expect(onStatusEntryVisited).toHaveBeenCalledTimes(2)
    expect(onAgentTypeLayoutVisited).toHaveBeenCalledTimes(2)
    expect(onUnsafeLayoutVisited).toHaveBeenCalledTimes(2)
  })

  it('shares one layout diff across both projections and walks previous layouts only on removal', () => {
    const onLayoutComparisonVisited = vi.fn()
    const onAgentTypeLayoutVisited = vi.fn()
    const onUnsafeLayoutVisited = vi.fn()
    const select = createTabBarAgentProjectionSelector({
      onLayoutComparisonVisited,
      onAgentTypeLayoutVisited,
      onUnsafeLayoutVisited
    })
    const statuses = { 'tab-0:leaf-a': entry({ agentType: 'claude' }) }
    const tabCount = 100
    let layouts: Record<string, TerminalLayoutSnapshot> = {}
    for (let index = 0; index < tabCount; index++) {
      layouts[`tab-${index}`] = splitLayout('leaf-a')
    }
    select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })
    onLayoutComparisonVisited.mockClear()
    onAgentTypeLayoutVisited.mockClear()
    onUnsafeLayoutVisited.mockClear()

    layouts = { ...layouts, 'tab-7': splitLayout('leaf-b') }
    select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })

    expect(onLayoutComparisonVisited).toHaveBeenCalledTimes(tabCount)
    expect(onAgentTypeLayoutVisited).toHaveBeenCalledTimes(1)
    expect(onUnsafeLayoutVisited).toHaveBeenCalledTimes(1)

    onLayoutComparisonVisited.mockClear()
    layouts = { ...layouts, 'tab-new': splitLayout('leaf-a') }
    select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })

    expect(onLayoutComparisonVisited).toHaveBeenCalledTimes(tabCount + 1)

    onLayoutComparisonVisited.mockClear()
    const { 'tab-7': _removed, ...withoutTab7 } = layouts
    layouts = withoutTab7
    const afterRemoval = select({
      agentStatusByPaneKey: statuses,
      terminalLayoutsByTabId: layouts
    })

    // A removal is the one case that needs the second walk to find the dropped key.
    expect(onLayoutComparisonVisited).toHaveBeenCalledTimes(tabCount + tabCount + 1)
    expect(afterRemoval.nativeChatTabWideFallbackUnsafeTabsById['tab-7']).toBeUndefined()
  })

  it('patches incrementally to the same result as a full projection', () => {
    // Why: an LCG multiply past 2^53 loses low bits and collapses the picks onto a few cases.
    const nextRandom = mulberry32(7)
    const random = (limit: number): number => Math.floor(nextRandom() * limit)
    const tabCount = 8
    const agents = ['claude', 'codex', 'grok', undefined] as const
    const leaves = ['leaf-a', 'leaf-b', 'leaf-c'] as const
    const layoutChoices: TerminalLayoutSnapshot[] = [
      splitLayout('leaf-a'),
      splitLayout('leaf-b'),
      splitLayout(null),
      splitLayout('leaf-c'),
      {
        root: { type: 'leaf', leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null
      },
      { root: null, activeLeafId: 'leaf-a', expandedLeafId: null },
      { root: null, activeLeafId: null, expandedLeafId: null }
    ]
    const select = createTabBarAgentProjectionSelector()
    let statuses: Record<string, AgentStatusEntry> = {}
    let layouts: Record<string, TerminalLayoutSnapshot> = {}
    const seenTabIds = new Set<string>()
    const seenAgents = new Set<(typeof agents)[number]>()
    const seenLayouts = new Set<TerminalLayoutSnapshot>()
    const appliedOperations = new Set<number>()
    for (let step = 0; step < 2_000; step++) {
      const tabId = `tab-${random(tabCount)}`
      const paneKey = `${tabId}:${leaves[random(leaves.length)]}`
      const operation = random(7)
      seenTabIds.add(tabId)
      // A status ping for a missing pane falls through, like operation 6, to reselect unchanged inputs.
      if (operation !== 1 || statuses[paneKey]) {
        appliedOperations.add(operation)
      }
      if (operation === 0) {
        const agentType = agents[random(agents.length)]
        seenAgents.add(agentType)
        statuses = { ...statuses, [paneKey]: entry({ agentType }) }
      } else if (operation === 1 && statuses[paneKey]) {
        statuses = {
          ...statuses,
          [paneKey]: { ...statuses[paneKey], state: 'done' }
        }
      } else if (operation === 2) {
        const { [paneKey]: _removed, ...rest } = statuses
        statuses = rest
      } else if (operation === 3) {
        // Same keys and entries in a new insertion order.
        statuses = Object.fromEntries(Object.entries(statuses).toReversed())
      } else if (operation === 4) {
        const layout = layoutChoices[random(layoutChoices.length)]!
        seenLayouts.add(layout)
        layouts = { ...layouts, [tabId]: layout }
      } else if (operation === 5) {
        const { [tabId]: _removed, ...rest } = layouts
        layouts = rest
      }
      const result = select({
        agentStatusByPaneKey: statuses,
        terminalLayoutsByTabId: layouts
      })
      expect(result.tabAgentTypesByTabId).toEqual(selectTabAgentTypesByTabId(statuses, layouts))
      expect(result.nativeChatTabWideFallbackUnsafeTabsById).toEqual(
        selectNativeChatTabWideFallbackUnsafeTabsById(layouts)
      )
    }
    // Why: a degenerate generator silently narrows the differential check, so pin what it exercised.
    expect(seenTabIds.size).toBe(tabCount)
    expect(seenAgents).toEqual(new Set(agents))
    expect(seenLayouts).toEqual(new Set(layoutChoices))
    expect(appliedOperations).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
  })

  it('normalizes missing maps to shared empty inputs', () => {
    const select = createTabBarAgentProjectionSelector()

    const first = select({})

    expect(select({})).toBe(first)
  })

  it('keeps agent evidence stable across saved launch preference changes', () => {
    const onStatusEntryVisited = vi.fn()
    const onAgentTypeLayoutVisited = vi.fn()
    const onUnsafeLayoutVisited = vi.fn()
    const select = createTabBarAgentProjectionSelector({
      onStatusEntryVisited,
      onAgentTypeLayoutVisited,
      onUnsafeLayoutVisited
    })
    const state = {
      settings: { nativeChatProviders: { claude: true } },
      agentStatusByPaneKey: { 'tab-1:leaf-a': entry({ agentType: 'claude' }) },
      terminalLayoutsByTabId: { 'tab-1': splitLayout('leaf-a') }
    }
    const cliState = { ...state, settings: { nativeChatProviders: { claude: false } } }
    const first = select(state)
    const disabled = select(cliState)
    const afterReenable = select(state)

    expect(disabled.tabAgentTypesByTabId).toEqual({ 'tab-1': 'claude' })
    expect(disabled).toBe(first)
    expect(afterReenable).toBe(first)
    expect(onStatusEntryVisited).toHaveBeenCalledTimes(1)
    expect(onAgentTypeLayoutVisited).toHaveBeenCalledTimes(1)
    expect(onUnsafeLayoutVisited).toHaveBeenCalledTimes(1)
  })

  it('production selector scans once and reuses agent evidence', () => {
    let statusEnumerations = 0
    let layoutEnumerations = 0
    const statuses = new Proxy(
      { 'tab-1:leaf-a': entry({ agentType: 'claude' }) },
      {
        ownKeys(target) {
          statusEnumerations++
          return Reflect.ownKeys(target)
        }
      }
    )
    const layouts = new Proxy(
      { 'tab-1': splitLayout('leaf-a') },
      {
        ownKeys(target) {
          layoutEnumerations++
          return Reflect.ownKeys(target)
        }
      }
    )
    const state = { agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts }

    const projections = selectTabBarAgentProjections(state)
    for (let consumer = 0; consumer < 100; consumer++) {
      expect(selectTabBarAgentProjections(state)).toBe(projections)
    }
    expect(statusEnumerations).toBe(1)
    expect(layoutEnumerations).toBe(2)
  })
})
