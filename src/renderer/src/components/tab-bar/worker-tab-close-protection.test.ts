// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/workspace-layout/terminal-tab-types'

const toasts = vi.hoisted(() => ({
  calls: [] as { message: string; id?: string; action?: { onClick: () => void } }[]
}))
vi.mock('sonner', () => {
  const toast = (message: string, options?: { id?: string; action?: { onClick: () => void } }) => {
    toasts.calls.push({ message, id: options?.id, action: options?.action })
    return options?.id ?? 'toast'
  }
  return { toast: Object.assign(toast, { error: toast, warning: toast, success: toast }) }
})

const owner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.isMain
  }
}))
// Main's layout answer lands at once, so a close that main would perform finishes inside the test.
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  sendLayoutApply: (
    _state: unknown,
    _workspace: string,
    command: { type: string; tabId?: string },
    hooks: { apply: (result: { closed: string[] }) => void }
  ) => {
    hooks.apply({ closed: command.tabId ? [command.tabId] : [] })
    return true
  }
}))

import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import { useTabGroupCloseScopeCommands } from '../tab-group/workspace-model/useTabGroupCloseScopeCommands'
import { useTabGroupTabCloseCommands } from '../tab-group/workspace-model/useTabGroupTabCloseCommands'
import { handleWorkerTabUserClose } from './worker-tab-user-close'
import { selectWorkerTabStripState } from './worker-tab-presentation'

const WORKER_LEAF = '00000000-0000-4000-8000-000000000001'
const USER_LEAF = '00000000-0000-4000-8000-000000000002'
const WT = 'wt'

function workerTab(id: string, groupId: string, workerLeafId = WORKER_LEAF): Tab {
  return makeUnifiedTab({
    id,
    worktreeId: WT,
    groupId,
    workerTab: {
      origin: {
        runId: 'run',
        dispatchId: `dispatch-${id}`,
        taskId: `task-${id}`,
        workerLeafId,
        parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
        coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
      }
    }
  })
}

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (...leafIds: string[]): TerminalPaneLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first: leaf(leafIds[0]!),
  second: leaf(leafIds[1]!)
})

function layouts(roots: Record<string, TerminalPaneLayoutNode>) {
  return Object.fromEntries(
    Object.entries(roots).map(([tabId, root]) => [
      tabId,
      { root, activeLeafId: null, expandedLeafId: null }
    ])
  )
}

function seed(options: {
  tabs: Tab[]
  groups: { id: string; activeTabId: string | null; tabOrder: string[] }[]
  roots: Record<string, TerminalPaneLayoutNode>
  hidden?: string[]
}): void {
  useAppStore.setState({
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: options.groups[0]!.id },
    workerTabsMode: 'open-when-clicked',
    workerTabStripChoiceByWorktree: {
      [WT]: Object.fromEntries((options.hidden ?? []).map((id) => [id, 'hidden' as const]))
    },
    workerTabPeekByGroupId: {},
    unifiedTabsByWorktree: { [WT]: options.tabs },
    groupsByWorktree: {
      [WT]: options.groups.map((group) => makeTabGroup({ ...group, worktreeId: WT }))
    },
    terminalLayoutsByTabId: layouts(options.roots)
  })
}

function spyDestructive() {
  const state = useAppStore.getState()
  return {
    closeUnifiedTab: vi.spyOn(state, 'closeUnifiedTab'),
    closeTab: vi.spyOn(state, 'closeTab'),
    closeEmptyGroup: vi.spyOn(state, 'closeEmptyGroup'),
    moveUnifiedTabToGroup: vi.spyOn(state, 'moveUnifiedTabToGroup')
  }
}

function expectNothingClosedOrMoved(spies: ReturnType<typeof spyDestructive>): void {
  expect(spies.closeUnifiedTab).not.toHaveBeenCalled()
  expect(spies.closeTab).not.toHaveBeenCalled()
  expect(spies.closeEmptyGroup).not.toHaveBeenCalled()
  expect(spies.moveUnifiedTabToGroup).not.toHaveBeenCalled()
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  toasts.calls.length = 0
  vi.restoreAllMocks()
})

describe.each([false, true])('layout owner is main: %s', (isMain) => {
  beforeEach(() => {
    owner.isMain = isMain
  })

  function closeSplitPane(groupId: string): ReturnType<typeof vi.fn> {
    const closeItem = vi.fn()
    const { result } = renderHook(() =>
      useTabGroupCloseScopeCommands({ groupId, worktreeId: WT, closeItem, closeMany: vi.fn() })
    )
    result.current.closeGroup()
    return closeItem
  }

  it('Close split pane keeps a worker-only pane whole and names one worker', async () => {
    seed({
      tabs: [
        workerTab('w1', 'pane'),
        makeUnifiedTab({ id: 'u', worktreeId: WT, groupId: 'other' })
      ],
      groups: [
        { id: 'pane', activeTabId: 'w1', tabOrder: ['w1'] },
        { id: 'other', activeTabId: 'u', tabOrder: ['u'] }
      ],
      roots: { w1: leaf(WORKER_LEAF), u: leaf(USER_LEAF) }
    })
    const spies = spyDestructive()
    const closeItem = closeSplitPane('pane')
    await settle()
    expect(closeItem).not.toHaveBeenCalled()
    expectNothingClosedOrMoved(spies)
    expect(useAppStore.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      'w1',
      'u'
    ])
    expect(toasts.calls).toEqual([
      { message: 'This pane has a worker · stop or close it first', id: 'worker-pane-kept:pane' }
    ])
  })

  it('Close split pane keeps a mixed pane, counts every worker and closes no user tab', async () => {
    seed({
      tabs: [
        workerTab('mixed', 'pane'),
        workerTab('w2', 'pane'),
        makeUnifiedTab({ id: 'user', worktreeId: WT, groupId: 'pane' })
      ],
      groups: [
        { id: 'pane', activeTabId: 'user', tabOrder: ['mixed', 'w2', 'user'] },
        { id: 'other', activeTabId: null, tabOrder: [] }
      ],
      roots: {
        mixed: split(WORKER_LEAF, USER_LEAF),
        w2: leaf(WORKER_LEAF),
        user: leaf(USER_LEAF)
      }
    })
    const spies = spyDestructive()
    const closeItem = closeSplitPane('pane')
    await settle()
    expect(closeItem).not.toHaveBeenCalled()
    expectNothingClosedOrMoved(spies)
    expect(toasts.calls.map((call) => [call.message, call.action])).toEqual([
      ['This pane has 2 workers · stop or close them first', undefined]
    ])
  })

  it('a folded-only pane offers Show, which peeks the most recent folded worker of that pane', async () => {
    seed({
      tabs: [workerTab('w1', 'pane'), workerTab('w2', 'pane'), workerTab('elsewhere', 'other')],
      groups: [
        { id: 'pane', activeTabId: null, tabOrder: ['w1', 'w2'] },
        { id: 'other', activeTabId: null, tabOrder: ['elsewhere'] }
      ],
      roots: { w1: leaf(WORKER_LEAF), w2: leaf(WORKER_LEAF), elsewhere: leaf(WORKER_LEAF) },
      hidden: ['w1', 'w2', 'elsewhere']
    })
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: 'pane',
            worktreeId: WT,
            activeTabId: null,
            tabOrder: ['w1', 'w2'],
            recentTabIds: ['elsewhere', 'w2', 'w1']
          }),
          makeTabGroup({ id: 'other', worktreeId: WT, activeTabId: null, tabOrder: ['elsewhere'] })
        ]
      }
    })
    const spies = spyDestructive()
    // Cmd/Ctrl+W with no tab selected lands on the pane itself.
    expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
    await settle()
    expectNothingClosedOrMoved(spies)
    expect(toasts.calls).toHaveLength(1)
    expect(toasts.calls[0]!.message).toBe('This pane has 2 workers · stop or close them first')
    toasts.calls[0]!.action!.onClick()
    const pane = useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === 'pane')
    expect(pane?.activeTabId).toBe('w1')
    expect(
      useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === 'other')
        ?.activeTabId
    ).toBeNull()
  })

  it('× and Cmd/Ctrl+W keep a mixed tab, repeat one note and send no close', async () => {
    seed({
      tabs: [
        workerTab('mixed', 'pane'),
        makeUnifiedTab({ id: 'u', worktreeId: WT, groupId: 'pane' })
      ],
      groups: [{ id: 'pane', activeTabId: 'mixed', tabOrder: ['mixed', 'u'] }],
      roots: { mixed: split(WORKER_LEAF, USER_LEAF), u: leaf(USER_LEAF) }
    })
    const spies = spyDestructive()
    for (let press = 0; press < 3; press++) {
      expect(
        dispatchWorkspaceTabCommand({
          type: 'close',
          target: { kind: 'tab', worktreeId: WT, tabId: 'mixed' }
        })
      ).toBe(true)
      expect(handleWorkerTabUserClose('mixed')).toBe(true)
    }
    await settle()
    expectNothingClosedOrMoved(spies)
    expect(new Set(toasts.calls.map((call) => call.id))).toEqual(new Set(['worker-tab-kept:mixed']))
    expect(toasts.calls[0]!.message).toBe('This tab has a worker · close your terminal pane first')
    // The mixed tab never folds, so it draws as an ordinary tab with no Hide.
    expect(selectWorkerTabStripState(useAppStore.getState(), WT, 'pane', 'mixed')).toBe('none')
  })

  it('a worker-only tab hides on × without closing anything', async () => {
    seed({
      tabs: [workerTab('w1', 'pane'), makeUnifiedTab({ id: 'u', worktreeId: WT, groupId: 'pane' })],
      groups: [{ id: 'pane', activeTabId: 'w1', tabOrder: ['w1', 'u'] }],
      roots: { w1: leaf(WORKER_LEAF), u: leaf(USER_LEAF) }
    })
    const spies = spyDestructive()
    expect(
      dispatchWorkspaceTabCommand({
        type: 'close',
        target: { kind: 'tab', worktreeId: WT, tabId: 'w1' }
      })
    ).toBe(true)
    await settle()
    expectNothingClosedOrMoved(spies)
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w1).toBe('hidden')
  })

  it('a tab mixed after its menu opened keeps its note instead of hiding', () => {
    seed({
      tabs: [workerTab('w1', 'pane')],
      groups: [{ id: 'pane', activeTabId: 'w1', tabOrder: ['w1'] }],
      roots: { w1: leaf(WORKER_LEAF) }
    })
    expect(selectWorkerTabStripState(useAppStore.getState(), WT, 'pane', 'w1')).toBe('peek')
    // The user splits their own terminal into the worker's tab while the menu is open.
    useAppStore.setState({ terminalLayoutsByTabId: layouts({ w1: split(WORKER_LEAF, USER_LEAF) }) })
    expect(handleWorkerTabUserClose('w1')).toBe(true)
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w1).toBeUndefined()
    expect(toasts.calls.map((call) => call.id)).toEqual(['worker-tab-kept:w1'])
  })

  it('a stamped tab whose worker pane is gone closes as an ordinary tab', () => {
    seed({
      tabs: [workerTab('left', 'pane')],
      groups: [{ id: 'pane', activeTabId: 'left', tabOrder: ['left'] }],
      roots: { left: leaf(USER_LEAF) }
    })
    expect(handleWorkerTabUserClose('left')).toBe(false)
    expect(selectWorkerTabStripState(useAppStore.getState(), WT, 'pane', 'left')).toBe('none')
    expect(toasts.calls).toEqual([])
  })

  it('a never-mounted worker tab hides with the leaf Orca made, as the fold does', async () => {
    seed({
      tabs: [workerTab('w1', 'pane'), makeUnifiedTab({ id: 'u', worktreeId: WT, groupId: 'pane' })],
      groups: [{ id: 'pane', activeTabId: 'u', tabOrder: ['w1', 'u'] }],
      roots: { u: leaf(USER_LEAF) }
    })
    const spies = spyDestructive()
    expect(handleWorkerTabUserClose('w1')).toBe(true)
    await settle()
    expectNothingClosedOrMoved(spies)
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w1).toBe('hidden')
  })

  it('a stamped terminal with neither a layout nor a stamped leaf stays open', async () => {
    const unknown = workerTab('w1', 'pane')
    delete unknown.workerTab!.origin.workerLeafId
    seed({
      tabs: [unknown],
      groups: [{ id: 'pane', activeTabId: 'w1', tabOrder: ['w1'] }],
      roots: {}
    })
    const spies = spyDestructive()
    expect(handleWorkerTabUserClose('w1')).toBe(true)
    await settle()
    expectNothingClosedOrMoved(spies)
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w1).toBeUndefined()
    expect(toasts.calls.map((call) => call.id)).toEqual(['worker-tab-kept:w1'])
  })

  it('Close Others keeps the mixed tab, closes the two ordinary ones and says so once', async () => {
    const ordinary = (id: string) =>
      makeUnifiedTab({ id, worktreeId: WT, groupId: 'pane', contentType: 'simulator' })
    seed({
      tabs: [ordinary('anchor'), workerTab('mixed', 'pane'), ordinary('a'), ordinary('b')],
      groups: [{ id: 'pane', activeTabId: 'anchor', tabOrder: ['anchor', 'mixed', 'a', 'b'] }],
      roots: { mixed: split(WORKER_LEAF, USER_LEAF) }
    })
    expect(useAppStore.getState().closeOtherTabs('anchor').sort()).toEqual(['a', 'b', 'mixed'])
    await settle()
    expect(useAppStore.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      'anchor',
      'mixed'
    ])
    expect(toasts.calls.map((call) => call.message)).toEqual(['Kept 1 tab with a worker'])
  })

  it('the pane bulk close counts kept tabs once; per-tab rechecks add no note', () => {
    seed({
      tabs: [workerTab('mixed', 'pane'), workerTab('later', 'pane')],
      groups: [{ id: 'pane', activeTabId: 'mixed', tabOrder: ['mixed', 'later'] }],
      roots: { mixed: split(WORKER_LEAF, USER_LEAF), later: leaf(WORKER_LEAF) }
    })
    const { result } = renderHook(() => useTabGroupTabCloseCommands({ worktreeId: WT }))
    result.current.closeMany(['mixed'])
    expect(toasts.calls.map((call) => call.message)).toEqual(['Kept 1 tab with a worker'])
    // A target that turned mixed after admission is skipped silently.
    useAppStore.setState({
      terminalLayoutsByTabId: layouts({
        mixed: split(WORKER_LEAF, USER_LEAF),
        later: split(WORKER_LEAF, USER_LEAF)
      })
    })
    expect(handleWorkerTabUserClose('later', true)).toBe(true)
    expect(toasts.calls).toHaveLength(1)
  })
})
