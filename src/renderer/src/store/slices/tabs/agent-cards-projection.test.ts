import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../shared/tab-types'
import { makeTab } from '../store-test-helpers'
import { projectAgentCardsToOrdinaryTabs } from './agent-cards-projection'

function tab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'home',
    worktreeId: 'wt',
    contentType: 'agent-session',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function group(
  id: string,
  tabOrder: string[],
  activeTabId: string | null = tabOrder[0] ?? null
): TabGroup {
  return { id, worktreeId: 'wt', activeTabId, tabOrder }
}

describe('projectAgentCardsToOrdinaryTabs', () => {
  it('returns the same arrays when the worktree has no cards', () => {
    const tabs = [tab({ id: 'term', contentType: 'terminal', groupId: 'home' })]
    const groups = [group('home', ['term'])]
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const result = projectAgentCardsToOrdinaryTabs({ tabs, groups, layout, cardGroupIds: [] })
    expect(result.tabs).toBe(tabs)
    expect(result.groups).toBe(groups)
    expect(result.layout).toBe(layout)
  })

  it('flattens carded agents into the Agents tab home group in card order', () => {
    const tabs = [
      tab({ id: 'agents', contentType: 'agents', groupId: 'home', entityId: 'agents:wt' }),
      tab({ id: 'term', contentType: 'terminal', groupId: 'home' }),
      tab({ id: 'a1', groupId: 'card-1' }),
      tab({ id: 'a2', groupId: 'card-2' })
    ]
    const groups = [
      group('home', ['agents', 'term']),
      group('card-1', ['a1']),
      group('card-2', ['a2'])
    ]
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const result = projectAgentCardsToOrdinaryTabs({
      tabs,
      groups,
      layout,
      cardGroupIds: ['card-1', 'card-2']
    })
    expect(result.tabs.some((item) => item.contentType === 'agents')).toBe(false)
    expect(result.groups.map((item) => item.id)).toEqual(['home'])
    expect(result.groups[0].tabOrder).toEqual(['term', 'a1', 'a2'])
    expect(
      result.tabs
        .filter((item) => item.id === 'a1' || item.id === 'a2')
        .every((item) => item.groupId === 'home')
    ).toBe(true)
    expect(result.layout).toBe(layout)
  })

  it('returns unchanged when the layout is undefined (I1: no group is a card group by default)', () => {
    const tabs = [tab({ id: 'a1', contentType: 'agent-session', groupId: 'card-1' })]
    const groups = [group('card-1', ['a1'])]
    const result = projectAgentCardsToOrdinaryTabs({
      tabs,
      groups,
      layout: undefined,
      cardGroupIds: ['card-1']
    })
    expect(result.tabs).toBe(tabs)
    expect(result.groups).toBe(groups)
    expect(result.layout).toBeUndefined()
  })

  it('does not misclassify a legitimately off-layout group that is not a registered card group', () => {
    // Why: "not in the layout" alone is not a sound definition of "card group" (I1).
    const tabs = [
      tab({ id: 'term', contentType: 'terminal', groupId: 'home' }),
      tab({ id: 'off1', contentType: 'terminal', groupId: 'off-layout' })
    ]
    const groups = [group('home', ['term']), group('off-layout', ['off1'])]
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const result = projectAgentCardsToOrdinaryTabs({ tabs, groups, layout, cardGroupIds: [] })
    expect(result.tabs).toBe(tabs)
    expect(result.groups).toBe(groups)
  })

  it('does not strip a registered off-layout group that no longer holds only agent tabs (N1)', () => {
    // Why: registration alone is not sufficient either - a registered id whose group picked
    // up a non-agent tab must not be carded and dropped from the persisted session.
    const tabs = [
      tab({ id: 'term', contentType: 'terminal', groupId: 'home' }),
      tab({ id: 'mixed-agent', groupId: 'stale-card' }),
      tab({ id: 'mixed-file', contentType: 'editor', groupId: 'stale-card' })
    ]
    const groups = [group('home', ['term']), group('stale-card', ['mixed-agent', 'mixed-file'])]
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const result = projectAgentCardsToOrdinaryTabs({
      tabs,
      groups,
      layout,
      cardGroupIds: ['stale-card']
    })
    expect(result.tabs).toBe(tabs)
    expect(result.groups).toBe(groups)
  })

  it('cards a terminal-launched agent tab when the registry names its off-layout group (N1)', () => {
    // Why: a card group's member can be a terminal tab flagged launchAgent, not only an
    // agent-session tab; the agent-only check must see it via terminalTabs, not miss it.
    const tabs = [
      tab({ id: 'agents', contentType: 'agents', groupId: 'home', entityId: 'agents:wt' }),
      tab({ id: 'term-agent', contentType: 'terminal', groupId: 'card-1' })
    ]
    const groups = [group('home', ['agents']), group('card-1', ['term-agent'])]
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const result = projectAgentCardsToOrdinaryTabs({
      tabs,
      groups,
      layout,
      cardGroupIds: ['card-1'],
      terminalTabs: [makeTab({ id: 'term-agent', worktreeId: 'wt', launchAgent: 'claude' })]
    })
    expect(result.groups.map((item) => item.id)).toEqual(['home'])
    expect(result.tabs.find((item) => item.id === 'term-agent')?.groupId).toBe('home')
  })
})
