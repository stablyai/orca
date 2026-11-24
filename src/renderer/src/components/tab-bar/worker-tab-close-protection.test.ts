// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/workspace-layout/terminal-tab-types'

const owner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.isMain
  }
}))
// Main's layout answer lands at once, so a close main would perform finishes inside the test.
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  sendLayoutApply: (
    _state: unknown,
    _workspace: string,
    command: { tabId?: string },
    hooks: { apply: (result: { closed: string[] }) => void }
  ) => {
    hooks.apply({ closed: command.tabId ? [command.tabId] : [] })
    return true
  }
}))

import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import { keepWorkerPaneOnClose } from './worker-tab-user-close'
import { workerTabCloseKind } from './worker-tab-view-actions'

// Invariant: a close gesture this window admits never removes or moves a tab that holds a worker,
// while worker-free tabs still close as before.

const WORKER_LEAF = '00000000-0000-4000-8000-000000000001'
const USER_LEAF = '00000000-0000-4000-8000-000000000002'
const WT = 'wt'

function workerTab(id: string, groupId: string, workerLeafId?: string): Tab {
  return makeUnifiedTab({
    id,
    worktreeId: WT,
    groupId,
    workerTab: {
      origin: {
        runId: 'run',
        dispatchId: `dispatch-${id}`,
        taskId: `task-${id}`,
        ...(workerLeafId ? { workerLeafId } : {}),
        parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
        coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
      }
    }
  })
}
const ordinary = (id: string, groupId = 'pane'): Tab =>
  makeUnifiedTab({ id, worktreeId: WT, groupId, contentType: 'simulator' })
const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const mixedRoot: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: leaf(WORKER_LEAF),
  second: leaf(USER_LEAF)
}

function seed(
  tabs: Tab[],
  groups: { id: string; activeTabId: string | null; tabOrder: string[] }[],
  roots: Record<string, TerminalPaneLayoutNode>,
  hidden: string[] = []
): void {
  useAppStore.setState({
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: groups[0]!.id },
    workerTabsMode: 'open-when-clicked',
    workerTabStripChoiceByWorktree: {
      [WT]: Object.fromEntries(hidden.map((id) => [id, 'hidden' as const]))
    },
    workerTabPeekByGroupId: {},
    unifiedTabsByWorktree: { [WT]: tabs },
    groupsByWorktree: { [WT]: groups.map((group) => makeTabGroup({ ...group, worktreeId: WT })) },
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(roots).map(([id, root]) => [
        id,
        { root, activeLeafId: null, expandedLeafId: null }
      ])
    )
  })
}

const tabIds = () => useAppStore.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)
const groupOf = (id: string) =>
  useAppStore.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === id)?.groupId
const groupIds = () => useAppStore.getState().groupsByWorktree[WT]?.map((group) => group.id)

it('classifies a tab from its current leaves', () => {
  const state = (roots: Record<string, TerminalPaneLayoutNode>) => {
    seed([], [{ id: 'pane', activeTabId: null, tabOrder: [] }], roots)
    return useAppStore.getState()
  }
  const stamped = workerTab('w', 'pane', WORKER_LEAF)
  expect(workerTabCloseKind(state({}), ordinary('u'))).toBe('none')
  expect(workerTabCloseKind(state({ w: leaf(WORKER_LEAF) }), stamped)).toBe('pure')
  expect(workerTabCloseKind(state({ w: mixedRoot }), stamped)).toBe('mixed')
  // The worker's own leaf is gone: what is left is the user's tab.
  expect(workerTabCloseKind(state({ w: leaf(USER_LEAF) }), stamped)).toBe('none')
  // No current layout: the stamped leaf id alone proves nothing, so the tab stays protected.
  expect(workerTabCloseKind(state({}), stamped)).toBe('mixed')
})

describe.each([false, true])('layout owner is main: %s', (isMain) => {
  beforeEach(() => {
    owner.isMain = isMain
  })

  it('Close split pane keeps every pane that holds a worker, folded or mixed', () => {
    seed(
      [
        workerTab('pure', 'a', WORKER_LEAF),
        workerTab('mixed', 'b', WORKER_LEAF),
        ordinary('user', 'b'),
        workerTab('folded', 'c', WORKER_LEAF),
        ordinary('free', 'd')
      ],
      [
        { id: 'a', activeTabId: 'pure', tabOrder: ['pure'] },
        { id: 'b', activeTabId: 'user', tabOrder: ['mixed', 'user'] },
        { id: 'c', activeTabId: null, tabOrder: ['folded'] },
        { id: 'd', activeTabId: 'free', tabOrder: ['free'] }
      ],
      { pure: leaf(WORKER_LEAF), mixed: mixedRoot, folded: leaf(WORKER_LEAF) },
      ['folded']
    )
    expect(['a', 'b', 'c', 'd'].map((group) => keepWorkerPaneOnClose(WT, group))).toEqual([
      true,
      true,
      true,
      false
    ])
    // Cmd/Ctrl+W on the folded-only pane, which lands with nothing selected.
    useAppStore.setState({ activeGroupIdByWorktree: { [WT]: 'c' } })
    expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
    expect(tabIds()).toEqual(['pure', 'mixed', 'user', 'folded', 'free'])
    expect(groupIds()).toEqual(['a', 'b', 'c', 'd'])
    expect(['pure', 'mixed', 'folded'].map(groupOf)).toEqual(['a', 'b', 'c'])
  })

  it('× on a tab that turned mixed after its menu opened keeps it whole', () => {
    seed(
      [workerTab('w', 'pane', WORKER_LEAF), ordinary('u')],
      [{ id: 'pane', activeTabId: 'w', tabOrder: ['w', 'u'] }],
      { w: leaf(WORKER_LEAF) }
    )
    useAppStore.setState({
      terminalLayoutsByTabId: { w: { root: mixedRoot, activeLeafId: null, expandedLeafId: null } }
    })
    for (let press = 0; press < 2; press++) {
      expect(
        dispatchWorkspaceTabCommand({
          type: 'close',
          target: { kind: 'tab', worktreeId: WT, tabId: 'w' }
        })
      ).toBe(true)
    }
    expect(tabIds()).toEqual(['w', 'u'])
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w).toBeUndefined()
  })

  it('Close Others keeps the mixed tab, hides the worker-only one and closes the rest', () => {
    seed(
      [
        ordinary('anchor'),
        workerTab('mixed', 'pane', WORKER_LEAF),
        workerTab('pure', 'pane', WORKER_LEAF),
        ordinary('a'),
        ordinary('b')
      ],
      [{ id: 'pane', activeTabId: 'anchor', tabOrder: ['anchor', 'mixed', 'pure', 'a', 'b'] }],
      { mixed: mixedRoot, pure: leaf(WORKER_LEAF) }
    )
    useAppStore.getState().closeOtherTabs('anchor')
    expect(tabIds()).toEqual(['anchor', 'mixed', 'pure'])
    const choices = useAppStore.getState().workerTabStripChoiceByWorktree[WT]
    expect([choices?.pure, choices?.mixed]).toEqual(['hidden', undefined])
  })
})
