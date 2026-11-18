import { describe, expect, it } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { partitionPinnedTabOrder } from '../../../../../../shared/workspace-layout/tab-groups/tab-order'
import { orderByVisibleTabs } from './worktree-agent-visible-tab-order'

type Row = { name: string; tabId?: string }
const tabIdOf = (row: Row): string | undefined => row.tabId

function terminal(tab: { id: string; groupId: string; isPinned?: boolean }) {
  return makeUnifiedTab({ ...tab, worktreeId: 'workspace' })
}

describe('orderByVisibleTabs', () => {
  it('follows the tab order a drag wrote into the group', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on bravo', tabId: 'bravo' },
      { name: 'agent on charlie', tabId: 'charlie' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'alpha', groupId: 'main' }),
        terminal({ id: 'bravo', groupId: 'main' }),
        terminal({ id: 'charlie', groupId: 'main' })
      ],
      groups: [
        makeTabGroup({
          id: 'main',
          worktreeId: 'workspace',
          tabOrder: ['charlie', 'alpha', 'bravo']
        })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

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
      terminal({ id: 'alpha', groupId: 'main' }),
      terminal({ id: 'bravo', groupId: 'main' }),
      terminal({ id: 'charlie', groupId: 'main', isPinned: true })
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
          tabOrder: partitionPinnedTabOrder(['alpha', 'bravo', 'charlie'], tabs, 'charlie')
        })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual([
      'agent on charlie',
      'agent on alpha',
      'agent on bravo'
    ])
  })

  it('ranks split groups in layout order, not in group list order', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on left-tab', tabId: 'left-tab' },
      { name: 'agent on right-tab', tabId: 'right-tab' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'left-tab', groupId: 'left' }),
        terminal({ id: 'right-tab', groupId: 'right' })
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
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual(['agent on right-tab', 'agent on left-tab'])
  })

  it('ranks an agent-session tab by its tab id, not its session id', () => {
    // Arrange
    const rows: Row[] = [
      { name: 'agent on alpha', tabId: 'alpha' },
      { name: 'agent on session-tab', tabId: 'session-tab' }
    ]
    const strip = {
      tabs: [
        terminal({ id: 'alpha', groupId: 'main' }),
        makeUnifiedTab({
          id: 'session-tab',
          entityId: 'session',
          contentType: 'agent-session',
          worktreeId: 'workspace',
          groupId: 'main'
        })
      ],
      groups: [
        makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['session-tab', 'alpha'] })
      ],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

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
        terminal({ id: 'alpha', groupId: 'main' }),
        terminal({ id: 'bravo', groupId: 'main' })
      ],
      groups: [makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['bravo', 'alpha'] })],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

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
      tabs: [terminal({ id: 'yankee', groupId: 'main' })],
      groups: [makeTabGroup({ id: 'main', worktreeId: 'workspace', tabOrder: ['yankee'] })],
      layout: { type: 'leaf' as const, groupId: 'main' },
      legacyOrder: []
    }

    // Act
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

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
    const ordered = orderByVisibleTabs(rows, tabIdOf, strip)

    // Assert
    expect(ordered.map((row) => row.name)).toEqual(['agent on bravo', 'agent on alpha'])
  })
})
