// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { makeTab } from '../store/terminals/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/tabs/tab-group.test-fixture'
import { buildActiveSurfacePatch } from '../store/slices/tabs/tabs-surface'
import { useAppStore } from '../store'
import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'
import { switchFloatingWorkspaceTab } from '@/components/floating-terminal/floating-workspace-terminal-actions'

vi.mock('@/lib/workspace/tabs/cycled-tab-owner-activation', () => ({
  activateCycledTabOnOwner: vi.fn()
}))
vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  recordLayoutApply: vi.fn()
}))

afterEach(() => vi.restoreAllMocks())

function fixture(worktreeId: string) {
  const store = createTestStore()
  store.setState({
    settings: { ...store.getState().settings!, tabBarOrderMode: 'mru' },
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree: { [worktreeId]: 'group' },
    groupsByWorktree: {
      [worktreeId]: [
        makeTabGroup({ id: 'group', worktreeId, activeTabId: 'a', tabOrder: ['a', 'b', 'c'] })
      ]
    },
    tabsByWorktree: {
      [worktreeId]: ['a', 'b', 'c'].map((id) => makeTab({ id, worktreeId }))
    },
    unifiedTabsByWorktree: {
      [worktreeId]: ['a', 'b', 'c'].map((id) =>
        makeUnifiedTab({ id, entityId: id, worktreeId, groupId: 'group' })
      )
    }
  })
  store.setState(buildActiveSurfacePatch(store.getState(), worktreeId))
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  return store
}

describe('directional switching with MRU tab bar ordering', () => {
  it.each([
    { name: 'main same-type', worktreeId: 'wt', switchTab: handleSwitchTab },
    { name: 'main all-types', worktreeId: 'wt', switchTab: handleSwitchTabAcrossAllTypes },
    { name: 'main terminal', worktreeId: 'wt', switchTab: handleSwitchTerminalTab },
    ...(['same-type', 'all-types', 'terminal'] as const).map((mode) => ({
      name: `floating ${mode}`,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      switchTab: (direction: number) =>
        switchFloatingWorkspaceTab(useAppStore.getState(), direction, mode)
    }))
  ])('reaches every tab forward and backward in $name', ({ worktreeId, switchTab }) => {
    const store = fixture(worktreeId)
    for (const [direction, expected] of [
      [1, 'b'],
      [1, 'c'],
      [1, 'a'],
      [-1, 'c'],
      [-1, 'b'],
      [-1, 'a']
    ] as const) {
      expect(switchTab(direction)).toBe(true)
      expect(store.getState().getActiveTab(worktreeId)?.id).toBe(expected)
      expect(store.getState().groupsByWorktree[worktreeId][0].tabOrder[0]).toBe(expected)
    }
  })

  it('starts a new cycle from dragged order and after terminal input or pointer activation', () => {
    const store = fixture('wt')
    handleSwitchTab(1)
    handleSwitchTab(1)
    expect(store.getState().getActiveTab('wt')?.id).toBe('c')
    store.getState().reorderUnifiedTabs('group', ['c', 'a', 'b'])
    handleSwitchTab(1)
    expect(store.getState().getActiveTab('wt')?.id).toBe('a')
    store.getState().recordTabInteraction('a')
    handleSwitchTab(1)
    expect(store.getState().getActiveTab('wt')?.id).toBe('c')
    store.getState().activateTab('b')
    handleSwitchTab(-1)
    expect(store.getState().getActiveTab('wt')?.id).toBe('a')
  })
})
