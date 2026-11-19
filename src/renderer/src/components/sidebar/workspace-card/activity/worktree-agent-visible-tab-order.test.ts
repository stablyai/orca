import { describe, expect, it } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { partitionPinnedTabOrder } from '../../../../../../shared/workspace-layout/tab-groups/tab-order'
import { orderByVisibleTabs } from './worktree-agent-visible-tab-order'

type Row = { name: string; tabId?: string }

function terminal(tab: { id: string; entityId: string; groupId: string; isPinned?: boolean }) {
  return makeUnifiedTab({ ...tab, worktreeId: 'workspace' })
}

describe('orderByVisibleTabs', () => {
  it("follows the group's tab order, matching terminal agents by entity id", () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on bravo', tabId: 'bravo' },
      { name: 'agent on charlie', tabId: 'charlie' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'alpha-tab', entityId: 'alpha', groupId: 'main' }),
        terminal({ id: 'bravo-tab', entityId: 'bravo', groupId: 'main' }),
        terminal({ id: 'charlie-tab', entityId: 'charlie', groupId: 'main' })
      ],
      groups: [
        makeTabGroup({
          id: 'main',
          worktreeId: 'workspace',
          tabOrder: ['charlie-tab', 'alpha-tab', 'bravo-tab']
        })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'agent on charlie',
      'agent on alpha',
      'agent on bravo'
    ])
  })

  it('moves the agent of a pinned tab first', () => {
    // Arrange
    const tabs = [
      terminal({ id: 'alpha-tab', entityId: 'alpha', groupId: 'main' }),
      terminal({ id: 'bravo-tab', entityId: 'bravo', groupId: 'main' }),
      terminal({ id: 'charlie-tab', entityId: 'charlie', groupId: 'main', isPinned: true })
    ]
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on bravo', tabId: 'bravo' },
      { name: 'agent on charlie', tabId: 'charlie' }
    ]
    const strip = {
      tabs,
      groups: [
        makeTabGroup({
          id: 'main',
          worktreeId: 'workspace',
          tabOrder: partitionPinnedTabOrder(
            ['alpha-tab', 'bravo-tab', 'charlie-tab'],
            tabs,
            'charlie-tab'
          )
        })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'agent on charlie',
      'agent on alpha',
      'agent on bravo'
    ])
  })

  it('ranks split groups in layout order', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on left-tab', tabId: 'left-terminal' },
      { name: 'agent on right-tab', tabId: 'right-terminal' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'left-tab', entityId: 'left-terminal', groupId: 'left' }),
        terminal({ id: 'right-tab', entityId: 'right-terminal', groupId: 'right' })
      ],
      groups: [
        makeTabGroup({ id: 'left', worktreeId: 'workspace', tabOrder: ['left-tab'] }),
        makeTabGroup({ id: 'right', worktreeId: 'workspace', tabOrder: ['right-tab'] })
      ],
      layout: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, groupId: 'right' },
        second: { type: 'leaf' as const, groupId: 'left' }
      },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual(['agent on right-tab', 'agent on left-tab'])
  })

  it('ranks an agent-session tab by its tab id', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on session-tab', tabId: 'session-tab' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'alpha-tab', entityId: 'alpha', groupId: 'main' }),
        makeUnifiedTab({
          id: 'session-tab',
          entityId: 'session',
          contentType: 'agent-session',
          worktreeId: 'workspace',
          groupId: 'main'
        })
      ],
      groups: [
        makeTabGroup({
          id: 'main',
          worktreeId: 'workspace',
          tabOrder: ['session-tab', 'alpha-tab']
        })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual(['agent on session-tab', 'agent on alpha'])
  })

  it('keeps the incoming order of agents that share a tab', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'second agent on bravo', tabId: 'bravo' },
      { name: 'first agent on bravo', tabId: 'bravo' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'alpha-tab', entityId: 'alpha', groupId: 'main' }),
        terminal({ id: 'bravo-tab', entityId: 'bravo', groupId: 'main' })
      ],
      groups: [
        makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['bravo-tab', 'alpha-tab'] })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'second agent on bravo',
      'first agent on bravo',
      'agent on alpha'
    ])
  })

  it('puts agents with no visible tab after the ranked ones, in their incoming order', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on closed-tab', tabId: 'closed-tab' },
      { name: 'agent with no tab' },
      { name: 'agent on yankee', tabId: 'yankee' }
    ]
    const strip = {
      tabs: [terminal({ id: 'yankee-tab', entityId: 'yankee', groupId: 'main' })],
      groups: [makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['yankee-tab'] })],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'agent on yankee',
      'agent on closed-tab',
      'agent with no tab'
    ])
  })

  it('follows the legacy strip order before the groups hydrate', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on bravo', tabId: 'bravo' }
    ]
    const strip = { tabs: [], groups: [], layout: undefined, legacyOrder: ['bravo', 'alpha'] }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual(['agent on bravo', 'agent on alpha'])
  })

  it('ignores the legacy strip order once the groups hydrate', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent with no tab' },
      { name: 'agent on stale-tab', tabId: 'stale-tab' },
      { name: 'agent on yankee', tabId: 'yankee' }
    ]
    const strip = {
      tabs: [terminal({ id: 'yankee-tab', entityId: 'yankee', groupId: 'main' })],
      groups: [makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['yankee-tab'] })],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: ['stale-tab', 'yankee']
    }

    // Act
    const ordered = orderByVisibleTabs(rows, (row) => row.tabId, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'agent on yankee',
      'agent with no tab',
      'agent on stale-tab'
    ])
  })
})
