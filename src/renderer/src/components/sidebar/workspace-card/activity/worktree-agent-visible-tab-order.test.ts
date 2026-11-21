import { describe, expect, it } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { partitionPinnedTabOrder } from '../../../../../../shared/workspace-layout/tab-groups/tab-order'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { orderByVisibleTabs, type WorktreeTabLayout } from './worktree-agent-visible-tab-order'

type AgentRow = { name: string; terminalId?: string; tabId?: string }

const ONE_GROUP_ID = 'main'

function terminalTab({
  tabId,
  terminalId,
  groupId = ONE_GROUP_ID,
  isPinned
}: {
  tabId: string
  terminalId: string
  groupId?: string
  isPinned?: boolean
}): Tab {
  return makeUnifiedTab({
    id: tabId,
    entityId: terminalId,
    groupId,
    isPinned,
    worktreeId: 'workspace'
  })
}

function workspaceWithOneTabGroup({
  tabs,
  tabOrder
}: {
  tabs: Tab[]
  tabOrder: string[]
}): WorktreeTabLayout {
  return {
    tabs,
    groups: [makeTabGroup({ id: ONE_GROUP_ID, worktreeId: 'workspace', tabOrder })],
    layout: { type: 'leaf', groupId: ONE_GROUP_ID },
    legacyOrder: []
  }
}

describe('orderByVisibleTabs', () => {
  it("follows the group's tab order, matching terminal agents by terminal id", () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in alpha', terminalId: 'terminal-alpha' },
      { name: 'agent in bravo', terminalId: 'terminal-bravo' },
      { name: 'agent in charlie', terminalId: 'terminal-charlie' }
    ]
    const workspaceTabs = workspaceWithOneTabGroup({
      tabs: [
        terminalTab({ tabId: 'tab-alpha', terminalId: 'terminal-alpha' }),
        terminalTab({ tabId: 'tab-bravo', terminalId: 'terminal-bravo' }),
        terminalTab({ tabId: 'tab-charlie', terminalId: 'terminal-charlie' })
      ],
      tabOrder: ['tab-charlie', 'tab-alpha', 'tab-bravo']
    })

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in charlie',
      'agent in alpha',
      'agent in bravo'
    ])
  })

  it('moves the agent of a pinned tab first', () => {
    // Arrange
    const tabs = [
      terminalTab({ tabId: 'tab-alpha', terminalId: 'terminal-alpha' }),
      terminalTab({ tabId: 'tab-bravo', terminalId: 'terminal-bravo' }),
      terminalTab({ tabId: 'tab-charlie', terminalId: 'terminal-charlie', isPinned: true })
    ]
    const agentRows: AgentRow[] = [
      { name: 'agent in alpha', terminalId: 'terminal-alpha' },
      { name: 'agent in bravo', terminalId: 'terminal-bravo' },
      { name: 'agent in charlie', terminalId: 'terminal-charlie' }
    ]
    const workspaceTabs = workspaceWithOneTabGroup({
      tabs,
      tabOrder: partitionPinnedTabOrder(
        ['tab-alpha', 'tab-bravo', 'tab-charlie'],
        tabs,
        'tab-charlie'
      )
    })

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in charlie',
      'agent in alpha',
      'agent in bravo'
    ])
  })

  it('ranks split groups in layout order', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in left group', terminalId: 'terminal-left' },
      { name: 'agent in right group', terminalId: 'terminal-right' }
    ]
    const workspaceTabs: WorktreeTabLayout = {
      tabs: [
        terminalTab({ tabId: 'tab-left', terminalId: 'terminal-left', groupId: 'left' }),
        terminalTab({ tabId: 'tab-right', terminalId: 'terminal-right', groupId: 'right' })
      ],
      groups: [
        makeTabGroup({ id: 'left', worktreeId: 'workspace', tabOrder: ['tab-left'] }),
        makeTabGroup({ id: 'right', worktreeId: 'workspace', tabOrder: ['tab-right'] })
      ],
      layout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'right' },
        second: { type: 'leaf', groupId: 'left' }
      },
      legacyOrder: []
    }

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in right group',
      'agent in left group'
    ])
  })

  it('ranks an agent-session tab by its tab id', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in alpha', terminalId: 'terminal-alpha' },
      { name: 'agent in session tab', tabId: 'tab-session' }
    ]
    const workspaceTabs = workspaceWithOneTabGroup({
      tabs: [
        terminalTab({ tabId: 'tab-alpha', terminalId: 'terminal-alpha' }),
        makeUnifiedTab({
          id: 'tab-session',
          entityId: 'session',
          contentType: 'agent-session',
          worktreeId: 'workspace',
          groupId: ONE_GROUP_ID
        })
      ],
      tabOrder: ['tab-session', 'tab-alpha']
    })

    // Act
    const orderedAgentRows = orderByVisibleTabs(
      agentRows,
      (row) => row.terminalId ?? row.tabId,
      workspaceTabs
    )

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in session tab',
      'agent in alpha'
    ])
  })

  it('keeps the incoming order of agents that share a tab', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in alpha', terminalId: 'terminal-alpha' },
      { name: 'second agent in bravo', terminalId: 'terminal-bravo' },
      { name: 'first agent in bravo', terminalId: 'terminal-bravo' }
    ]
    const workspaceTabs = workspaceWithOneTabGroup({
      tabs: [
        terminalTab({ tabId: 'tab-alpha', terminalId: 'terminal-alpha' }),
        terminalTab({ tabId: 'tab-bravo', terminalId: 'terminal-bravo' })
      ],
      tabOrder: ['tab-bravo', 'tab-alpha']
    })

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'second agent in bravo',
      'first agent in bravo',
      'agent in alpha'
    ])
  })

  it('puts agents with no visible tab after the ranked ones, in their incoming order', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in closed tab', terminalId: 'terminal-closed' },
      { name: 'agent with no tab' },
      { name: 'agent in yankee', terminalId: 'terminal-yankee' }
    ]
    const workspaceTabs = workspaceWithOneTabGroup({
      tabs: [terminalTab({ tabId: 'tab-yankee', terminalId: 'terminal-yankee' })],
      tabOrder: ['tab-yankee']
    })

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in yankee',
      'agent in closed tab',
      'agent with no tab'
    ])
  })

  it('follows the legacy strip order before the groups hydrate', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent in alpha', terminalId: 'terminal-alpha' },
      { name: 'agent in bravo', terminalId: 'terminal-bravo' }
    ]
    const workspaceTabs: WorktreeTabLayout = {
      tabs: [],
      groups: [],
      layout: undefined,
      legacyOrder: ['terminal-bravo', 'terminal-alpha']
    }

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual(['agent in bravo', 'agent in alpha'])
  })

  it('ignores the legacy strip order once the groups hydrate', () => {
    // Arrange
    const agentRows: AgentRow[] = [
      { name: 'agent with no tab' },
      { name: 'agent in stale tab', terminalId: 'terminal-stale' },
      { name: 'agent in yankee', terminalId: 'terminal-yankee' }
    ]
    const workspaceTabs: WorktreeTabLayout = {
      ...workspaceWithOneTabGroup({
        tabs: [terminalTab({ tabId: 'tab-yankee', terminalId: 'terminal-yankee' })],
        tabOrder: ['tab-yankee']
      }),
      legacyOrder: ['terminal-stale', 'terminal-yankee']
    }

    // Act
    const orderedAgentRows = orderByVisibleTabs(agentRows, (row) => row.terminalId, workspaceTabs)

    // Assert
    expect(orderedAgentRows.map((row) => row.name)).toEqual([
      'agent in yankee',
      'agent with no tab',
      'agent in stale tab'
    ])
  })
})
