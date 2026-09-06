// STA-3475: the tab-cycle chord runs through the real group order helper here (no mock), because
// the bug was the seam between them — a group tab the strip renders but group.tabOrder had not
// learned about yet left the cycle with <=1 tab, so Terminal.tsx consumed the chord and nothing
// moved until a mouse click rewrote the group state.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('../store', () => ({ useAppStore: { getState: getStateMock } }))

import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'

const WT = 'wt-1'
const GROUP = 'group-1'

function terminalTab(id: string, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function stateWithGroupOrder(tabOrder: string[]) {
  const tabs = [
    terminalTab('tab-1', 'term-1', 0),
    terminalTab('tab-2', 'term-2', 1),
    terminalTab('tab-3', 'term-3', 2)
  ]
  return {
    activeWorktreeId: WT,
    activeTabType: 'terminal' as const,
    activeTabId: 'term-1',
    activeFileId: null,
    activeBrowserTabId: null,
    activeGroupIdByWorktree: { [WT]: GROUP },
    groupsByWorktree: {
      [WT]: [{ id: GROUP, worktreeId: WT, activeTabId: 'tab-1', tabOrder, recentTabIds: [] }]
    },
    unifiedTabsByWorktree: { [WT]: tabs },
    tabBarOrderByWorktree: {},
    tabsByWorktree: { [WT]: [{ id: 'term-1' }, { id: 'term-2' }, { id: 'term-3' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    setActiveTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveTabType: vi.fn(),
    activateTab: vi.fn()
  }
}

describe('tab-cycle chord against a group whose tabOrder is still hydrating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('switches to the group tab that group.tabOrder has not recorded yet', () => {
    const store = stateWithGroupOrder(['tab-1'])
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
  })

  it('switches across all types in the same hydrating state', () => {
    const store = stateWithGroupOrder(['tab-1'])
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-3')
  })

  it('still cycles in the recorded order once tabOrder is complete', () => {
    const store = stateWithGroupOrder(['tab-2', 'tab-1', 'tab-3'])
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-3')
  })

  it('cycles a terminal-only shortcut while the runtime row is still hydrating', () => {
    const store = stateWithGroupOrder(['tab-1'])
    store.tabsByWorktree = { [WT]: [{ id: 'term-1' }] }
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
  })

  it('cycles Ctrl+PageUp/PageDown through a unified terminal before its runtime row hydrates', () => {
    const store = stateWithGroupOrder(['tab-1'])
    store.tabsByWorktree = { [WT]: [{ id: 'term-1' }] }
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
  })

  it('uses the worktree order when keyboard activation sees an empty group projection', () => {
    const store = stateWithGroupOrder([])
    store.unifiedTabsByWorktree = { [WT]: [] }
    store.tabsByWorktree = { [WT]: [{ id: 'term-1' }, { id: 'term-2' }] }
    getStateMock.mockReturnValue(store)

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
  })
})
