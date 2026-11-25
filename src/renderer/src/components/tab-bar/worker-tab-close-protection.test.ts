// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type {
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/workspace-layout/terminal-tab-types'
import { act, renderHook } from '@testing-library/react'

const owner = vi.hoisted(() => ({
  isMain: false,
  publishFrame: (_workspace: string, _closed: readonly string[]): void => {}
}))
vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.isMain
  }
}))
// Main's layout answer lands at once: its frame drops the closed tabs, then the window hears the result.
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  sendLayoutApply: (
    _state: unknown,
    workspace: string,
    command: { tabId?: string; tabIds?: string[] },
    hooks: { apply: (result: { closed: string[] }) => void }
  ) => {
    const closed = command.tabIds ?? (command.tabId ? [command.tabId] : [])
    owner.publishFrame(workspace, closed)
    hooks.apply({ closed })
    return true
  }
}))

import { useAppStore } from '@/store'
import {
  makeStructuredChatTab,
  makeTabGroup,
  makeUnifiedTab
} from '@/store/slices/tabs/tab-group.test-fixture'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import {
  handleWorkerTabUserClose,
  keepWorkerPaneOnClose,
  showFoldedWorkerOfPane
} from './worker-tab-user-close'
import { selectWorkerTabPeekId } from './worker-tab-presentation'
import { closeTerminalTab } from '../terminal/tab-lifecycle/terminal-tab-actions'
import {
  stampedTaskTitleForRow,
  workerTabStampSchema
} from '../../../../shared/orchestration/workers/worker-tab-stamp'
import { workerTabCloseKind } from './worker-tab-view-actions'
import { selectFoldedWorkerTabIds } from './worker-tab-folding'
import { CoordinatorWorkerIndex } from './coordinator-worker-index'
import { admitBulkWorkerClose } from './worker-tab-close-target'
import { registerEditorFrameFlush } from '../editor/save/flush/editor-pending-flush'
import { useTerminalBulkCloseActions } from '../terminal/tab-lifecycle/use-terminal-bulk-close-actions'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import * as runtimeRpc from '@/runtime/rpc/calls/runtime-rpc-call'
import { closeCliChatResumeTerminal } from './session-actions/cli-chat-resume-close-terminal'

owner.publishFrame = (workspace, closed) =>
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [workspace]: (state.unifiedTabsByWorktree[workspace] ?? []).filter(
        (tab) => !closed.includes(tab.id)
      )
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [workspace]: (state.groupsByWorktree[workspace] ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => !closed.includes(id))
      }))
    }
  }))

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

function legacyTab(id: string, stamp?: TerminalTab['workerTab']): TerminalTab {
  return {
    id,
    worktreeId: WT,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(stamp ? { workerTab: stamp } : {})
  }
}

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
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
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

it('keeps an unbound restored chat visible while bound retained workers can still hide', () => {
  const unbound = workerTabStampSchema.parse({
    ...workerTab('legacy', 'pane').workerTab,
    agentIdentity: { agentType: 'claude' }
  })
  const bound = workerTabStampSchema.parse({
    ...unbound,
    structuredSessionLineageRootId: 'original-session'
  })
  const chats = [
    makeStructuredChatTab({
      id: 'legacy',
      worktreeId: WT,
      groupId: 'pane',
      entityId: 'unrelated-session',
      agentSessionAgent: 'claude',
      workerTab: unbound
    }),
    makeStructuredChatTab({
      id: 'retained',
      worktreeId: WT,
      groupId: 'pane',
      entityId: 'original-session',
      agentSessionAgent: 'claude',
      workerTab: bound
    }),
    makeStructuredChatTab({
      id: 'cleared',
      worktreeId: WT,
      groupId: 'pane',
      entityId: 'cleared-session',
      agentSessionLineageRootId: 'original-session',
      agentSessionAgent: 'claude',
      workerTab: bound
    })
  ]
  const order = ['anchor', 'legacy', 'retained', 'cleared']
  seed(
    [ordinary('anchor'), ...chats],
    [{ id: 'pane', activeTabId: 'anchor', tabOrder: order }],
    {},
    ['legacy']
  )
  const folded = () => selectFoldedWorkerTabIds(useAppStore.getState(), WT, 'pane')
  expect(folded().has('legacy')).toBe(false)
  useAppStore.getState().setWorkerTabStripChoice(WT, 'legacy', 'kept')

  for (const { id } of chats) {
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'tab', worktreeId: WT, tabId: id }
    })
  }

  expect(tabIds()).toEqual(order)
  expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]).toEqual({
    legacy: 'kept',
    retained: 'hidden',
    cleared: 'hidden'
  })
  expect(folded()).toEqual(new Set(['retained', 'cleared']))
})

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

  it('a rootless terminal with conflicting active and bound leaves stays open', () => {
    const tab = workerTab('w', 'pane', WORKER_LEAF)
    seed([tab], [{ id: 'pane', activeTabId: 'w', tabOrder: ['w'] }], {})
    useAppStore.setState({
      tabsByWorktree: { [WT]: [legacyTab('w', tab.workerTab)] },
      terminalLayoutsByTabId: {
        w: {
          root: null,
          activeLeafId: USER_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [WORKER_LEAF]: 'worker-pty', [USER_LEAF]: 'user-pty' }
        }
      }
    })
    closeTerminalTab('w', { reason: 'user', skipRunningProcessConfirm: true })
    expect(tabIds()).toEqual(['w'])
    expect(useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.w).toBeUndefined()
    expect(useAppStore.getState().terminalLayoutsByTabId.w?.activeLeafId).toBe(USER_LEAF)
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
    // Shown in the strip, so Close Others reaches it; a folded worker is already out of its reach.
    useAppStore.setState({ workerTabStripChoiceByWorktree: { [WT]: { pure: 'kept' } } })
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
      [WT]: [legacyTab('legacy', workerTab('legacy', 'pane', WORKER_LEAF).workerTab)]
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

it('keeps a stamped legacy terminal when its sole unified match is unrelated', () => {
  const worker = workerTab('shared', 'pane', WORKER_LEAF)
  seed([ordinary('shared')], [{ id: 'pane', activeTabId: 'shared', tabOrder: ['shared'] }], {
    shared: leaf(USER_LEAF)
  })
  useAppStore.setState({ tabsByWorktree: { [WT]: [legacyTab('shared', worker.workerTab)] } })

  closeTerminalTab('shared', { reason: 'user', skipRunningProcessConfirm: true })
  expect(useAppStore.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['shared'])
  expect(admitBulkWorkerClose(useAppStore.getState(), ['shared'])).toEqual(new Set(['shared']))

  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [worker] } })
  expect(admitBulkWorkerClose(useAppStore.getState(), ['shared'])).toEqual(new Set())
})

it('titlebar bulk close keeps a worker discovered during a held frame flush', async () => {
  owner.isMain = false
  const held = workerTab('held', 'pane', WORKER_LEAF)
  const tabs = [ordinary('anchor'), held, ordinary('free')]
  seed(tabs, [{ id: 'pane', activeTabId: 'anchor', tabOrder: ['anchor', 'held', 'free'] }], {
    held: leaf(USER_LEAF)
  })
  useAppStore.setState({ tabsByWorktree: { [WT]: [legacyTab('held', held.workerTab)] } })
  const frame = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush('held', () => frame.promise)
  const state = useAppStore.getState()
  const { result, unmount } = renderHook(
    () =>
      useTerminalBulkCloseActions({
        activeWorktreeId: WT,
        closeBrowserTab: state.closeBrowserTab,
        closeFile: state.closeFile,
        closeTab: state.closeTab,
        queueEditorCloseRequests: () => {}
      }),
    { wrapper: ConfirmationDialogProvider }
  )
  try {
    act(() => result.current.closeTabBarTabs(['held', 'free']))
    expect(tabIds()).toEqual(['anchor', 'held'])
    await act(async () => {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          held: { root: mixedRoot, activeLeafId: null, expandedLeafId: null }
        }
      })
      frame.resolve(true)
    })
    expect(tabIds()).toEqual(['anchor', 'held'])
    expect(useAppStore.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['held'])
  } finally {
    unregister()
    unmount()
  }
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
  showFoldedWorkerOfPane(WT, 'pane', new Map([['kept', 'runtime:another-host']]))
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

it('a pending Show action cannot activate a worker placed on a replacement host', () => {
  const tab = { ...workerTab('w', 'pane', WORKER_LEAF), executionHostId: 'runtime:before' as const }
  seed([tab], [{ id: 'pane', activeTabId: null, tabOrder: ['w'] }], { w: leaf(WORKER_LEAF) }, ['w'])
  const hosts = new Map([[tab.id, tab.executionHostId]])
  const replacement = { ...tab, executionHostId: 'runtime:after' as const }
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [replacement] } })
  showFoldedWorkerOfPane(WT, 'pane', hosts)
  expect(useAppStore.getState().groupsByWorktree[WT]?.[0]?.activeTabId).toBeNull()
  showFoldedWorkerOfPane(WT, 'pane', new Map([[tab.id, replacement.executionHostId]]))
  expect(useAppStore.getState().groupsByWorktree[WT]?.[0]?.activeTabId).toBe('w')
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

it('a removed worker leaf cannot keep its surviving tab in the coordinator list', () => {
  const coordinatorLeaf = '00000000-0000-4000-8000-000000000003'
  const coordinator = makeUnifiedTab({ id: 'coordinator', worktreeId: WT, groupId: 'pane' })
  const worker = workerTab('w', 'pane', WORKER_LEAF)
  const coordinatorIdentity = { kind: 'pane', paneKey: `coordinator:${coordinatorLeaf}` } as const
  worker.workerTab!.origin.coordinator = coordinatorIdentity
  seed(
    [coordinator, worker],
    [{ id: 'pane', activeTabId: 'coordinator', tabOrder: ['coordinator', 'w'] }],
    { coordinator: leaf(coordinatorLeaf), w: mixedRoot }
  )
  useAppStore.setState({
    runtimeAgentOrchestrationByPaneKey: {
      [`w:${WORKER_LEAF}`]: {
        taskId: 'task-w',
        dispatchId: 'dispatch-w',
        dispatchStatus: 'dispatched',
        coordinatorIdentity
      }
    }
  })
  const index = new CoordinatorWorkerIndex()
  index.update(useAppStore.getState())
  const coordinatorEntry = index.identities.byAlias('coordinator')!
  const memberIds = () => [...index.members(coordinatorEntry)].map(({ tab }) => tab.id)
  expect(memberIds()).toEqual(['w'])
  useAppStore.setState((state) => ({
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      w: { root: leaf(USER_LEAF), activeLeafId: USER_LEAF, expandedLeafId: null }
    }
  }))
  index.update(useAppStore.getState())
  expect(memberIds()).toEqual([])
})

const resumeId = 'resume'
const resumeWorkerTab = workerTab(resumeId, 'pane', WORKER_LEAF)
const resumeUserTab = makeUnifiedTab({ id: resumeId, worktreeId: WT, groupId: 'pane' })

it.each([
  {
    name: 'mixed worker',
    tab: resumeWorkerTab,
    root: mixedRoot,
    expected: false,
    remaining: ['resume']
  },
  {
    name: 'pure worker',
    tab: resumeWorkerTab,
    root: leaf(WORKER_LEAF),
    expected: false,
    remaining: ['resume']
  },
  {
    name: 'ordinary terminal',
    tab: resumeUserTab,
    root: leaf(WORKER_LEAF),
    expected: true,
    remaining: []
  },
  {
    name: 'external abort',
    tab: resumeUserTab,
    root: leaf(WORKER_LEAF),
    prepare: (controller: AbortController) => controller.abort(),
    expected: false,
    remaining: ['resume']
  }
])('Continue in chat settles for $name', async ({ tab, root, prepare, expected, remaining }) => {
  owner.isMain = false
  const id = resumeId
  seed([tab], [{ id: 'pane', activeTabId: id, tabOrder: [id] }], { [id]: root })
  useAppStore.setState({ tabsByWorktree: { [WT]: [legacyTab(id, tab.workerTab)] } })
  const controller = new AbortController()
  const rpc = vi.spyOn(runtimeRpc, 'callRuntimeRpc').mockImplementation(async (_target, method) => {
    if (method === 'terminal.resolvePane') {
      return { terminal: { handle: 'terminal', ptyId: 'pty-1', incarnationId: 'incarnation' } }
    }
    if (method === 'terminal.wait') {
      return { wait: { outcome: 'satisfied' } }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  vi.useFakeTimers()
  try {
    const settled: boolean[] = []
    const continuing = closeCliChatResumeTerminal(
      {
        tabId: id,
        workspaceId: WT,
        paneKey: `${id}:${WORKER_LEAF}`,
        agent: 'claude',
        providerSessionId: 'conversation',
        executionHostId: 'local'
      },
      () => true,
      {
        prepared: () => prepare?.(controller),
        closing: () => {},
        refused: () => {}
      },
      controller.signal
    ).then((result) => settled.push(result))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toEqual([expected])
    await continuing
    expect(useAppStore.getState().tabsByWorktree[WT]?.map((row) => row.id) ?? []).toEqual(remaining)
  } finally {
    controller.abort()
    rpc.mockRestore()
    vi.useRealTimers()
  }
})
