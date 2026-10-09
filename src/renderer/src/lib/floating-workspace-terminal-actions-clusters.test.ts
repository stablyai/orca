import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { switchFloatingWorkspaceTab } from './floating-workspace-terminal-actions'

const focusTerminalTabSurfaceMock = vi.hoisted(() => vi.fn())

vi.mock('./create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('./connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeUnifiedTerminalTab(id: string, groupId = 'floating-group'): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('switchFloatingWorkspaceTab', () => {
  beforeEach(() => {
    focusTerminalTabSurfaceMock.mockReset()
  })

  describe.each<Parameters<typeof switchFloatingWorkspaceTab>[2]>([
    'all-types',
    'same-type',
    'terminal'
  ])('%s with a collapsed cluster', (mode) => {
    it.each([
      {
        label: 'the only visible tab on next',
        tabOrder: ['a', 'b', 'c'],
        activeId: 'c',
        direction: 1,
        target: null
      },
      {
        label: 'the only visible tab on previous',
        tabOrder: ['a', 'b', 'c'],
        activeId: 'c',
        direction: -1,
        target: null
      },
      {
        label: 'the next visible tab across hidden members',
        tabOrder: ['a', 'b', 'c', 'd'],
        activeId: 'd',
        direction: 1,
        target: 'c'
      },
      {
        label: 'the previous visible tab across hidden members',
        tabOrder: ['a', 'b', 'c', 'd'],
        activeId: 'c',
        direction: -1,
        target: 'd'
      },
      {
        label: 'the shown member on next',
        tabOrder: ['a', 'b', 'c'],
        activeId: 'c',
        shownTabId: 'b',
        direction: 1,
        target: 'b'
      },
      {
        label: 'the active member on previous',
        tabOrder: ['a', 'b', 'c'],
        activeId: 'b',
        direction: -1,
        target: 'c'
      }
    ])(
      'skips hidden members for $label',
      ({ tabOrder, activeId, shownTabId, direction, target }) => {
        const group: TabGroup = {
          id: 'floating-group',
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          activeTabId: activeId,
          tabOrder,
          recentTabIds: [activeId],
          tabClusters: [
            {
              id: 'cluster',
              name: 'Work',
              color: 'blue',
              collapsed: true,
              tabIds: ['a', 'b'],
              ...(shownTabId ? { shownTabId } : {})
            }
          ]
        }
        const store = {
          activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: group.id },
          activateTab: vi.fn(),
          browserTabsByWorktree: {},
          groupsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [group] },
          openFiles: [],
          setActiveTab: vi.fn(),
          tabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: tabOrder.map((id) => makeTab(`entity-${id}`))
          },
          unifiedTabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: tabOrder.map((id) => ({
              ...makeUnifiedTerminalTab(id),
              entityId: `entity-${id}`
            }))
          }
        }

        expect(switchFloatingWorkspaceTab(store, direction, mode)).toBe(target !== null)
        expect(store.activateTab.mock.calls).toEqual(target ? [[target]] : [])
        expect(store.setActiveTab.mock.calls).toEqual(target ? [[`entity-${target}`]] : [])
        expect(focusTerminalTabSurfaceMock.mock.calls).toEqual(target ? [[`entity-${target}`]] : [])
        expect(group.tabClusters?.[0].collapsed).toBe(true)
      }
    )
  })
})
