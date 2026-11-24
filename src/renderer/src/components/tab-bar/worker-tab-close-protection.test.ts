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
import {
  handleWorkerTabUserClose,
  keepWorkerPaneOnClose,
  showFoldedWorkerOfPane
} from './worker-tab-user-close'
import { selectWorkerTabPeekId } from './worker-tab-presentation'
import { closeTerminalTab } from '../terminal/tab-lifecycle/terminal-tab-actions'
import { stampedTaskTitleForRow } from '../../../../shared/orchestration/workers/worker-tab-stamp'
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

describe.each([false, true])('per-target checks, layout owner is main: %s', (isMain) => {
  beforeEach(() => {
    owner.isMain = isMain
  })

  // Closing `a` changes what `b` holds; the bulk close must see that before it reaches `b`.
  function onClosed(id: string, then: () => void): () => void {
    return useAppStore.subscribe((state, previous) => {
      const was = previous.unifiedTabsByWorktree[WT]?.some((tab) => tab.id === id)
      const is = state.unifiedTabsByWorktree[WT]?.some((tab) => tab.id === id)
      if (was && !is) {
        then()
      }
    })
  }
  const setRoots = (roots: Record<string, TerminalPaneLayoutNode>) =>
    useAppStore.setState({
      terminalLayoutsByTabId: Object.fromEntries(
        Object.entries(roots).map(([id, root]) => [
          id,
          { root, activeLeafId: null, expandedLeafId: null }
        ])
      )
    })

  it('a target that turns mixed while earlier targets close is kept', () => {
    seed(
      [ordinary('anchor'), ordinary('a'), workerTab('b', 'pane', WORKER_LEAF)],
      [{ id: 'pane', activeTabId: 'anchor', tabOrder: ['anchor', 'a', 'b'] }],
      { b: leaf(USER_LEAF) }
    )
    const stop = onClosed('a', () => setRoots({ b: mixedRoot }))
    useAppStore.getState().closeOtherTabs('anchor')
    stop()
    expect(tabIds()).toEqual(['anchor', 'b'])
  })

  it('a target mixed when the close was chosen stays out even if it turns ordinary meanwhile', () => {
    seed(
      [ordinary('anchor'), ordinary('a'), workerTab('b', 'pane', WORKER_LEAF)],
      [{ id: 'pane', activeTabId: 'anchor', tabOrder: ['anchor', 'a', 'b'] }],
      { b: mixedRoot }
    )
    const stop = onClosed('a', () => setRoots({ b: leaf(USER_LEAF) }))
    useAppStore.getState().closeOtherTabs('anchor')
    stop()
    expect(tabIds()).toEqual(['anchor', 'b'])
  })
})

it('a stamped legacy-only row or an ambiguous worker address is kept, not closed', () => {
  seed([], [{ id: 'pane', activeTabId: null, tabOrder: [] }], {})
  useAppStore.setState({
    tabsByWorktree: {
      [WT]: [
        {
          id: 'legacy',
          worktreeId: WT,
          ptyId: null,
          title: 'Worker',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          workerTab: workerTab('legacy', 'pane', WORKER_LEAF).workerTab
        }
      ]
    }
  })
  expect(handleWorkerTabUserClose('legacy')).toBe(true)
  expect(useAppStore.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['legacy'])
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {
      [WT]: [workerTab('same', 'pane', WORKER_LEAF)],
      other: [makeUnifiedTab({ id: 'same', worktreeId: 'other', groupId: 'g' })]
    }
  })
  expect(handleWorkerTabUserClose('same')).toBe(true)
})

it('Show peeks only a folded worker still ordered in that pane on the same host', () => {
  seed(
    [workerTab('stray', 'pane', WORKER_LEAF), workerTab('kept', 'pane', WORKER_LEAF)],
    [{ id: 'pane', activeTabId: null, tabOrder: ['kept'] }],
    { stray: leaf(WORKER_LEAF), kept: leaf(WORKER_LEAF) },
    ['stray', 'kept']
  )
  useAppStore.setState({
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: 'pane',
          worktreeId: WT,
          activeTabId: null,
          tabOrder: ['kept'],
          recentTabIds: ['kept', 'stray']
        })
      ]
    }
  })
  const active = () => useAppStore.getState().groupsByWorktree[WT]?.[0]?.activeTabId
  showFoldedWorkerOfPane(WT, 'pane', new Map([['kept', 'another-host']]))
  expect(active()).toBeNull()
  showFoldedWorkerOfPane(
    WT,
    'pane',
    new Map([
      ['stray', undefined],
      ['kept', undefined]
    ])
  )
  expect(active()).toBe('kept')
})

it('a stamp whose worker pane is gone is no peek and lends no task title', () => {
  const inert = workerTab('inert', 'pane', WORKER_LEAF)
  inert.workerTab!.origin.taskTitle = 'Task'
  seed([inert], [{ id: 'pane', activeTabId: 'inert', tabOrder: ['inert'] }], {
    inert: leaf(USER_LEAF)
  })
  expect(selectWorkerTabPeekId(useAppStore.getState(), WT, 'pane')).toBeUndefined()
  expect(stampedTaskTitleForRow(inert, `inert:${USER_LEAF}`)).toBeUndefined()
  expect(stampedTaskTitleForRow(inert, `inert:${WORKER_LEAF}`)).toBe('Task')
})

it('a close the worker guard consumes reports a cancel to its caller', () => {
  seed(
    [workerTab('mixed', 'pane', WORKER_LEAF)],
    [{ id: 'pane', activeTabId: 'mixed', tabOrder: ['mixed'] }],
    { mixed: mixedRoot }
  )
  const onCancel = vi.fn()
  closeTerminalTab('mixed', { reason: 'user', onCancel })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(tabIds()).toEqual(['mixed'])
})
