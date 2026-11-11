// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { makeTab } from '../store/terminals/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/tabs/tab-group.test-fixture'
import { buildActiveSurfacePatch } from '../store/slices/tabs/tabs-surface'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/workspace/tabs/cycled-tab-owner-activation', () => ({
  activateCycledTabOnOwner: vi.fn()
}))
vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

import { handleSwitchTerminalTab } from './ipc-tab-switch'
import { switchFloatingWorkspaceTab } from '@/components/floating-terminal/floating-workspace-terminal-actions'

describe.each(['main', 'floating'] as const)('%s terminal shortcut chat order', (surface) => {
  it('cycles terminal, chat, terminal in both directions using exact tab selection', () => {
    const worktreeId = surface === 'floating' ? FLOATING_TERMINAL_WORKTREE_ID : 'wt-1'
    const store = createTestStore()
    const rows = [
      makeUnifiedTab({ id: 'unified-term-1', entityId: 'term-1', worktreeId, groupId: 'group' }),
      makeUnifiedTab({
        id: 'chat',
        entityId: 'session',
        contentType: 'agent-session',
        worktreeId,
        groupId: 'group'
      }),
      makeUnifiedTab({ id: 'unified-term-2', entityId: 'term-2', worktreeId, groupId: 'group' })
    ]
    store.setState({
      activeWorktreeId: worktreeId,
      activeGroupIdByWorktree: { [worktreeId]: 'group' },
      groupsByWorktree: {
        [worktreeId]: [
          makeTabGroup({
            id: 'group',
            worktreeId,
            activeTabId: 'unified-term-1',
            tabOrder: rows.map((tab) => tab.id)
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'term-1', worktreeId }), makeTab({ id: 'term-2', worktreeId })]
      },
      unifiedTabsByWorktree: { [worktreeId]: rows }
    })
    store.setState(buildActiveSurfacePatch(store.getState(), worktreeId))
    mocks.getState.mockImplementation(store.getState)
    for (const [direction, expectedTabId] of [
      [1, 'chat'],
      [1, 'unified-term-2'],
      [1, 'unified-term-1'],
      [-1, 'unified-term-2'],
      [-1, 'chat'],
      [-1, 'unified-term-1']
    ] as const) {
      expect(
        surface === 'floating'
          ? switchFloatingWorkspaceTab(store.getState(), direction, 'terminal')
          : handleSwitchTerminalTab(direction)
      ).toBe(true)
      expect(store.getState().getActiveTab(worktreeId)?.id).toBe(expectedTabId)
    }
  })
})
