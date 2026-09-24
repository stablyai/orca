import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import {
  AGENT_CARDS_MAX,
  agentStatusTabIdForTab,
  isCardedAgentTab,
  selectAgentTabs,
  selectAgentsTab
} from './agent-card-tabs'

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'g',
    worktreeId: 'wt',
    contentType: 'terminal',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeTerminalTab(overrides: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    ptyId: null,
    worktreeId: 'wt',
    title: overrides.id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

describe('selectAgentTabs', () => {
  it('keeps a structured agent-session tab with no terminal tabs supplied at all', () => {
    const tabs = [
      makeTab({ id: 't1', contentType: 'terminal' }),
      makeTab({ id: 'a1', contentType: 'agent-session' }),
      makeTab({ id: 'e1', contentType: 'editor' })
    ]
    expect(selectAgentTabs(tabs, []).map((tab) => tab.id)).toEqual(['a1'])
  })

  it('matches a terminal-route agent tab via the sibling TerminalTab.launchAgent', () => {
    const tabs = [makeTab({ id: 'tab1', entityId: 'term1', contentType: 'terminal' })]
    const terminalTabs = [makeTerminalTab({ id: 'term1', launchAgent: 'claude' })]
    expect(selectAgentTabs(tabs, terminalTabs).map((tab) => tab.id)).toEqual(['tab1'])
  })

  it('rejects a plain terminal tab with no launchAgent', () => {
    const tabs = [makeTab({ id: 'tab1', entityId: 'term1', contentType: 'terminal' })]
    const terminalTabs = [makeTerminalTab({ id: 'term1' })]
    expect(selectAgentTabs(tabs, terminalTabs)).toEqual([])
  })

  it('never matches the Agents tab as an agent', () => {
    const tabs = [makeTab({ id: 'agents', contentType: 'agents', entityId: 'agents:wt' })]
    expect(selectAgentTabs(tabs, [])).toEqual([])
  })

  it('orders by createdAt, then sortOrder, then id, across both agent routes', () => {
    const tabs = [
      makeTab({ id: 'a3', contentType: 'agent-session', sortOrder: 1, createdAt: 5 }),
      makeTab({
        id: 'a1',
        entityId: 'term1',
        contentType: 'terminal',
        sortOrder: 0,
        createdAt: 10
      }),
      makeTab({ id: 'a2', contentType: 'agent-session', sortOrder: 0, createdAt: 1 })
    ]
    const terminalTabs = [makeTerminalTab({ id: 'term1', launchAgent: 'claude' })]
    expect(selectAgentTabs(tabs, terminalTabs).map((tab) => tab.id)).toEqual(['a2', 'a3', 'a1'])
  })
})

describe('selectAgentsTab', () => {
  it('returns the container tab when present', () => {
    const tabs = [
      makeTab({ id: 'a1', contentType: 'agent-session' }),
      makeTab({ id: 'agents', contentType: 'agents', entityId: 'agents:wt' })
    ]
    expect(selectAgentsTab(tabs)?.id).toBe('agents')
  })
})

describe('agentStatusTabIdForTab', () => {
  it('returns the sibling TerminalTab id for a terminal-route tab', () => {
    expect(agentStatusTabIdForTab(makeTab({ id: 'tab1', entityId: 'term1' }))).toBe('term1')
  })

  it('returns the tab id for a structured agent-session tab', () => {
    expect(agentStatusTabIdForTab(makeTab({ id: 'a1', contentType: 'agent-session' }))).toBe('a1')
  })
})

describe('isCardedAgentTab', () => {
  it('is true only when the tab lives in a listed card group', () => {
    const tab = makeTab({ id: 'a1', contentType: 'agent-session', groupId: 'card-1' })
    expect(isCardedAgentTab({ agentCardGroupIdsByWorktree: { wt: ['card-1'] } }, tab)).toBe(true)
    expect(isCardedAgentTab({ agentCardGroupIdsByWorktree: { wt: ['other'] } }, tab)).toBe(false)
  })
})

describe('AGENT_CARDS_MAX', () => {
  it('is capped at 9', () => {
    expect(AGENT_CARDS_MAX).toBe(9)
  })
})
