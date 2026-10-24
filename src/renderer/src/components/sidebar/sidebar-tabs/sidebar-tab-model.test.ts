import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../../shared/terminal-tab-types'
import { buildSidebarTabItems, type SidebarTabModelInput } from './sidebar-tab-model'

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'entityId' | 'contentType'>): Tab {
  return {
    groupId: 'g1',
    worktreeId: 'wt',
    label: '',
    customLabel: null,
    color: null,
    sortOrder: 0,
    ...overrides
  } as Tab
}

function input(overrides: Partial<SidebarTabModelInput>): SidebarTabModelInput {
  return {
    unifiedTabs: [],
    groups: [],
    activeGroupId: 'g1',
    terminalTabs: [],
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    openFiles: [],
    browserWorkspaces: [],
    generatedTitlesEnabled: false,
    ...overrides
  }
}

const group = (tabOrder: string[], activeTabId: string): TabGroup =>
  ({ id: 'g1', worktreeId: 'wt', activeTabId, tabOrder }) as TabGroup

describe('buildSidebarTabItems', () => {
  it('follows group tab order and marks the active tab', () => {
    const items = buildSidebarTabItems(
      input({
        unifiedTabs: [
          tab({ id: 'a', entityId: 'b1', contentType: 'browser', label: 'Docs' }),
          tab({ id: 'b', entityId: 't1', contentType: 'terminal' })
        ],
        groups: [group(['b', 'a'], 'a')],
        terminalTabs: [{ id: 't1', title: 'zsh' } as TerminalTab]
      })
    )
    expect(items.map((item) => [item.tab.id, item.title, item.isActive])).toEqual([
      ['b', 'zsh', false],
      ['a', 'Docs', true]
    ])
  })

  it('turns a split terminal tab into one pill of panes', () => {
    const layout = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'left' },
        second: { type: 'leaf', leafId: 'right' }
      },
      activeLeafId: 'right',
      expandedLeafId: null,
      titlesByLeafId: { left: 'Claude' }
    } as unknown as TerminalLayoutSnapshot
    const [item] = buildSidebarTabItems(
      input({
        unifiedTabs: [tab({ id: 'a', entityId: 't1', contentType: 'terminal' })],
        groups: [group(['a'], 'a')],
        terminalTabs: [{ id: 't1', title: 'zsh' } as TerminalTab],
        terminalLayoutsByTabId: { t1: layout }
      })
    )
    expect(item.panes).toEqual([
      { leafId: 'left', title: 'Claude', isActive: false },
      { leafId: 'right', title: 'Pane 2', isActive: true }
    ])
  })

  it('keeps single-pane terminals as plain rows and prefers custom labels', () => {
    const [item] = buildSidebarTabItems(
      input({
        unifiedTabs: [
          tab({ id: 'a', entityId: 't1', contentType: 'terminal', customLabel: 'Server' })
        ],
        groups: [group(['a'], 'a')],
        terminalTabs: [{ id: 't1', title: 'zsh' } as TerminalTab]
      })
    )
    expect(item.panes).toBeNull()
    expect(item.title).toBe('Server')
  })

  it('still lists a tab missing from tabOrder', () => {
    const items = buildSidebarTabItems(
      input({
        unifiedTabs: [tab({ id: 'orphan', entityId: 'x', contentType: 'simulator', label: 'Sim' })],
        groups: [group([], '')]
      })
    )
    expect(items.map((item) => item.title)).toEqual(['Sim'])
  })
})
