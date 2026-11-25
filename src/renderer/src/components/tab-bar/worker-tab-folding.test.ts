// @vitest-environment happy-dom
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { preserveWorkerTabFrameSelections } from './worker-tab-frame-selection'
import { repairActiveTerminalTab } from '../terminal/workspace-mounting/use-active-terminal-repair'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorkerTabStamp } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { activateTabNumberShortcut } from '@/lib/keyboard/tab-number-shortcuts'

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))
import { getActiveTabNavOrder } from '../../lib/workspace/tabs/order/group-tab-order'
import { selectReachableWorkerPaneKeys, selectFoldedWorkerTabIds } from './worker-tab-folding'
import { hideWorkerTab } from './worker-tab-hide'
import { keepWorkerTabOnUserInput } from './worker-tab-keep-on-input'
import { applyWorkerTabsMode } from './worker-tabs-mode-switch'
import { selectCoordinatorNeedsYouCount, selectCoordinatorWorkers } from './worker-tab-presentation'

const TEST_NOW = 100_000
const WT = 'wt-1'
const GROUP = 'group-1'
const LEAF: Record<string, string> = {
  coord: '00000000-0000-4000-8000-000000000000',
  w1: '00000000-0000-4000-8000-000000000001',
  w2: '00000000-0000-4000-8000-000000000002',
  w3: '00000000-0000-4000-8000-000000000003',
  closed: '00000000-0000-4000-8000-000000000009'
}
const paneOf = (id: string) => ({ kind: 'pane', paneKey: `${id}:${LEAF[id]}` }) as const
const coordinatorPane = paneOf('coord')

function stamp(
  id: string,
  parent: WorkerTabStamp['origin']['parent'] = coordinatorPane
): WorkerTabStamp {
  return {
    origin: {
      runId: 'run-1',
      dispatchId: `dispatch-${id}`,
      taskId: `task-${id}`,
      taskTitle: `Task ${id}`,
      parent,
      coordinator: coordinatorPane,
      workerLeafId: LEAF[id]
    }
  }
}

function tab(id: string, workerTab?: WorkerTabStamp): Tab {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    // Just created: still in its fold grace, so it folds before any sidebar row exists.
    createdAt: TEST_NOW,
    ...(workerTab ? { workerTab } : {})
  }
}

function seed(activeTabId: string, tabs: Tab[]): void {
  const group: TabGroup = {
    id: GROUP,
    worktreeId: WT,
    activeTabId,
    tabOrder: tabs.map((t) => t.id),
    recentTabIds: [activeTabId]
  }
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: GROUP },
    groupsByWorktree: { [WT]: [group] },
    unifiedTabsByWorktree: { [WT]: tabs },
    tabsByWorktree: {
      [WT]: tabs
        .filter((t) => t.contentType === 'terminal')
        .map((t) => ({
          id: t.id,
          ptyId: null,
          worktreeId: WT,
          title: t.id,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: t.createdAt
        }))
    },
    // Each terminal holds only the leaf Orca created for it, so a stamped tab is a pure worker tab.
    terminalLayoutsByTabId: Object.fromEntries(
      tabs
        .filter((t) => t.contentType === 'terminal')
        .map((t) => [
          t.entityId,
          {
            root: {
              type: 'leaf' as const,
              leafId: t.workerTab?.origin.workerLeafId ?? LEAF[t.id] ?? `leaf-${t.id}`
            },
            activeLeafId: null,
            expandedLeafId: null
          }
        ])
    ),
    workerTabsMode: 'open-when-clicked',
    workerTabPeekByGroupId: {},
    workerTabStripChoiceByWorktree: {},
    workerTabFailOpenShown: {},
    runtimeAgentOrchestrationByPaneKey: {}
  })
}

const folded = () => selectFoldedWorkerTabIds(useAppStore.getState(), WT, GROUP)
const choice = (id: string) => useAppStore.getState().workerTabStripChoiceByWorktree[WT]?.[id]

afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies only the UI persistence bridge used by these actions.
  ;(window as unknown as { api: unknown }).api = {
    ui: { set: vi.fn().mockResolvedValue(undefined) }
  }
  seed('coord', [tab('coord'), tab('w1', stamp('w1')), tab('w2', stamp('w2'))])
})

describe('worker tab folding', () => {
  it('folds workers out of the strip and out of next/previous order', () => {
    expect([...folded()].sort()).toEqual(['w1', 'w2'])
    const order = getActiveTabNavOrder(useAppStore.getState(), WT, {}, () => folded())
    expect(order.map((ref) => ref.tabId)).toEqual(['coord'])
  })

  it('opening a worker peeks it, and opening another re-folds the first', () => {
    useAppStore.getState().activateTab('w1', { worktreeId: WT })
    expect(useAppStore.getState().workerTabPeekByGroupId[GROUP]).toBe('w1')
    useAppStore.getState().activateTab('w2', { worktreeId: WT })
    expect(useAppStore.getState().workerTabPeekByGroupId[GROUP]).toBe('w2')
    useAppStore.getState().activateTab('coord', { worktreeId: WT })
    expect([...folded()]).toEqual(['w1'])
  })

  it('hiding the open worker folds it, lands on a visible tab and closes nothing', () => {
    useAppStore.getState().activateTab('w1', { worktreeId: WT })
    expect(hideWorkerTab('w1')).toBe(true)
    const state = useAppStore.getState()
    expect(choice('w1')).toBe('hidden')
    expect(state.groupsByWorktree[WT]![0]!.activeTabId).toBe('coord')
    expect(state.unifiedTabsByWorktree[WT]!.map((t) => t.id)).toEqual(['coord', 'w1', 'w2'])
  })

  it('leaves a pane of only workers on its landing instead of reselecting one', () => {
    seed('w1', [tab('w1', stamp('w1')), tab('w2', stamp('w2'))])
    expect(hideWorkerTab('w1')).toBe(true)
    expect(useAppStore.getState().groupsByWorktree[WT]![0]!.activeTabId).toBeNull()
  })

  it('keeps an empty focused pane on its landing when another pane has a visible terminal', () => {
    const state = useAppStore.getState()
    useAppStore.setState({
      activeGroupIdByWorktree: { [WT]: 'landing' },
      groupsByWorktree: {
        [WT]: [
          ...state.groupsByWorktree[WT]!,
          { id: 'landing', worktreeId: WT, activeTabId: null, tabOrder: [] }
        ]
      }
    })
    const setActiveTab = vi.fn()
    expect(
      repairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: null,
        activeTabIdByWorktree: {},
        renderedActiveWorktreeId: WT,
        setActiveTab,
        tabs: useAppStore.getState().tabsByWorktree[WT]!
      })
    ).toBe(false)
    expect(setActiveTab).not.toHaveBeenCalled()
  })

  it('does not hide an ordinary tab', () => {
    expect(hideWorkerTab('coord')).toBe(false)
  })

  it('Close Others folds a kept worker without removing either worker surface', () => {
    useAppStore.getState().setWorkerTabStripChoice(WT, 'w1', 'kept')
    useAppStore.getState().closeOtherTabs('coord')
    expect(useAppStore.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      'coord',
      'w1',
      'w2'
    ])
    expect([...folded()].sort()).toEqual(['w1', 'w2'])
  })

  it('typing keeps a worker, but interrupts and answers to a prompt do not', () => {
    keepWorkerTabOnUserInput(WT, 'w1', '\x03')
    expect(choice('w1')).toBeUndefined()
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [`w1:${LEAF.w1}`]: {
          taskId: 'task-w1',
          dispatchId: 'dispatch-w1',
          dispatchStatus: 'dispatched',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    keepWorkerTabOnUserInput(WT, 'w1', 'y')
    expect(choice('w1')).toBeUndefined()
    keepWorkerTabOnUserInput(WT, 'w2', 'ls\r')
    expect(choice('w2')).toBe('kept')
  })

  it('switching back to Open when clicked never folds the tab a pane is showing', () => {
    useAppStore.setState({ workerTabsMode: 'always-open' })
    useAppStore.getState().activateTab('w1', { worktreeId: WT })
    useAppStore.setState({ workerTabPeekByGroupId: {} })
    applyWorkerTabsMode('open-when-clicked')
    useAppStore.getState().activateTab('coord', { worktreeId: WT })
    expect([...folded()]).toEqual(['w2'])
  })
})

describe('coordinator badge', () => {
  it('counts a waiting sub-worker under a folded helper and names the helper', () => {
    const helperPane = paneOf('w1')
    seed('coord', [tab('coord'), tab('w1', stamp('w1')), tab('w3', stamp('w3', helperPane))])
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [`w3:${LEAF.w3}`]: {
          taskId: 'task-w3',
          dispatchId: 'dispatch-w3',
          dispatchStatus: 'dispatched',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    const state = useAppStore.getState()
    expect(selectCoordinatorNeedsYouCount(state, 'coord')).toBe(1)
    const waiting = selectCoordinatorWorkers(state, 'coord').find((e) => e.tab.id === 'w3')
    expect(waiting?.viaTitle).toBe('Task w1')
  })

  it('keeps counting a sub-worker whose helper tab is gone', () => {
    const goneHelper = paneOf('closed')
    seed('coord', [tab('coord'), tab('w3', stamp('w3', goneHelper))])
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [`w3:${LEAF.w3}`]: {
          taskId: 'task-w3',
          dispatchId: 'dispatch-w3',
          dispatchStatus: 'dispatched',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    const state = useAppStore.getState()
    expect(selectCoordinatorNeedsYouCount(state, 'coord')).toBe(1)
    expect(selectCoordinatorWorkers(state, 'coord')[0]?.viaClosedWorker).toBe(true)
  })
})

describe('worker tab number shortcuts', () => {
  it('activates visible kept tabs before the worker peek, skipping folded workers', () => {
    useAppStore.getState().setWorkerTabStripChoice(WT, 'w2', 'kept')
    useAppStore.getState().activateTab('w1', { worktreeId: WT })
    expect(activateTabNumberShortcut(1)).toBe(true)
    expect(useAppStore.getState().groupsByWorktree[WT]![0]!.activeTabId).toBe('w2')
    expect(activateTabNumberShortcut(2)).toBe(true)
    expect(useAppStore.getState().groupsByWorktree[WT]![0]!.activeTabId).toBe('w1')
  })

  it('does not activate a folded worker through an out-of-range number', () => {
    expect(activateTabNumberShortcut(1)).toBe(false)
    expect(useAppStore.getState().groupsByWorktree[WT]![0]!.activeTabId).toBe('coord')
    expect([...folded()]).toEqual(['w1', 'w2'])
  })

  it('activates a native chat in its own view instead of selecting an editor', () => {
    seed('coord', [
      tab('coord'),
      {
        ...tab('w1', stamp('w1')),
        contentType: 'agent-session',
        entityId: 'chat-session',
        agentSessionAgent: 'codex'
      }
    ])
    useAppStore.getState().setWorkerTabStripChoice(WT, 'w1', 'kept')
    expect(activateTabNumberShortcut(1)).toBe(true)
    expect(useAppStore.getState().groupsByWorktree[WT]![0]!.activeTabId).toBe('w1')
    expect(useAppStore.getState().activeTabType).toBe('agent-session')
  })
})

describe('durable coordinator attribution', () => {
  it('uses the next live worker context after its first pane moves behind another pane', () => {
    seed('coord', [tab('coord'), tab('w1')])
    const firstKey = `w1:${LEAF.w1}`
    const secondKey = `w1:${LEAF.w2}`
    const first = {
      paneKey: firstKey,
      tabId: 'w1',
      worktreeId: WT,
      state: 'working' as const,
      agentType: 'codex',
      prompt: 'Work',
      stateHistory: [],
      updatedAt: TEST_NOW,
      stateStartedAt: TEST_NOW,
      orchestration: {
        taskId: 'first-task',
        dispatchId: 'first-dispatch',
        coordinatorIdentity: coordinatorPane,
        taskTitle: 'First pane task',
        attention: { categories: ['input' as const], requiresAction: true }
      }
    }
    const second = {
      ...first,
      paneKey: secondKey,
      orchestration: {
        ...first.orchestration,
        taskId: 'second-task',
        dispatchId: 'second-dispatch',
        taskTitle: 'Second pane task',
        attention: { categories: [], requiresAction: false }
      }
    }
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [firstKey, first],
        [secondKey, second]
      ])
    })
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'coord')).toBe(1)
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: state.agentStatusByPaneKey.replace([
        [firstKey, null],
        [firstKey, first]
      ])
    }))
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'coord')).toBe(0)
    expect(selectCoordinatorWorkers(useAppStore.getState(), 'coord')[0]?.title).toBe(
      'Second pane task'
    )
  })

  it('counts a pre-stamp worker when the live context names its coordinator', () => {
    seed('coord', [tab('coord'), tab('w1')])
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [`w1:${LEAF.w1}`]: {
          taskId: 'old-task',
          dispatchId: 'old-dispatch',
          coordinatorIdentity: coordinatorPane,
          parentIdentity: coordinatorPane,
          taskTitle: 'Existing worker',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'coord')).toBe(1)
    expect(selectCoordinatorWorkers(useAppStore.getState(), 'coord')[0]?.title).toBe(
      'Existing worker'
    )
  })

  it('follows a coordinator leaf detached from its old tab into a new tab', () => {
    seed('coord', [tab('coord'), tab('moved'), tab('w1', stamp('w1'))])
    useAppStore.setState({
      terminalLayoutsByTabId: {
        coord: {
          root: { type: 'leaf', leafId: LEAF.w2! },
          activeLeafId: LEAF.w2!,
          expandedLeafId: null
        },
        moved: {
          root: { type: 'leaf', leafId: LEAF.coord! },
          activeLeafId: LEAF.coord!,
          expandedLeafId: null
        }
      },
      runtimeAgentOrchestrationByPaneKey: {
        [`w1:${LEAF.w1}`]: {
          taskId: 'task-w1',
          dispatchId: 'dispatch-w1',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'coord')).toBe(0)
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'moved')).toBe(1)
  })

  it('resolves a cleared native-chat coordinator by its original session root', () => {
    const coordinator = { kind: 'session', lineageRootSessionId: 'original-coordinator' } as const
    const helper = { kind: 'session', lineageRootSessionId: 'helper-session' } as const
    const helperStamp = stamp('w1')
    helperStamp.origin.parent = coordinator
    helperStamp.origin.coordinator = coordinator
    const childStamp = stamp('w3', helper)
    childStamp.origin.coordinator = coordinator
    seed('coord', [
      {
        ...tab('coord'),
        contentType: 'agent-session',
        entityId: 'cleared-coordinator',
        agentSessionLineageRootId: 'original-coordinator'
      },
      { ...tab('w1', helperStamp), contentType: 'agent-session', entityId: 'helper-session' },
      { ...tab('w3', childStamp), contentType: 'agent-session', entityId: 'child-session' }
    ])
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [structuredAgentSessionPaneKey('w3', 'child-session')]: {
          taskId: 'task-w3',
          dispatchId: 'dispatch-w3',
          attention: { categories: ['input'], requiresAction: true }
        }
      }
    })
    expect(selectCoordinatorNeedsYouCount(useAppStore.getState(), 'coord')).toBe(1)
    expect(
      selectCoordinatorWorkers(useAppStore.getState(), 'coord').find(
        (entry) => entry.tab.id === 'w3'
      )?.viaTitle
    ).toBe('Task w1')
  })
})

it('keeps a folded-only pane on its landing when a main-owned frame supplies a first-tab fallback', () => {
  seed('w1', [tab('w1', stamp('w1')), tab('w2', stamp('w2'))])
  hideWorkerTab('w1')
  const state = useAppStore.getState()
  const built = preserveWorkerTabFrameSelections(state, {
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    groupsByWorktree: { [WT]: [{ ...state.groupsByWorktree[WT]![0]!, activeTabId: 'w1' }] },
    activeTabIdByWorktree: { [WT]: 'w1' }
  })
  expect(built.groupsByWorktree[WT]![0]!.activeTabId).toBeNull()
  expect(built.activeTabIdByWorktree[WT]).toBeNull()
})

it('refreshes emitted-row reachability when an accepted status write adds or removes a worker', () => {
  const paneKey = 'w1:00000000-0000-4000-8000-000000000001'
  const entry = {
    paneKey,
    worktreeId: WT,
    tabId: 'w1',
    state: 'working' as const,
    agentType: 'codex',
    prompt: 'Work',
    stateHistory: [],
    updatedAt: TEST_NOW,
    stateStartedAt: TEST_NOW
  }
  useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[paneKey, entry]]) })
  const populated = useAppStore.getState()
  expect(selectReachableWorkerPaneKeys(populated, WT).has(paneKey)).toBe(true)
  useAppStore.setState({
    agentStatusByPaneKey: populated.agentStatusByPaneKey.replace([
      [paneKey, { ...entry, toolInput: 'Inspect files' }]
    ])
  })
  const updated = useAppStore.getState()
  expect(selectReachableWorkerPaneKeys(updated, WT).has(paneKey)).toBe(true)
  useAppStore.setState({
    agentStatusByPaneKey: updated.agentStatusByPaneKey.replace([[paneKey, null]])
  })
  const removed = useAppStore.getState()
  expect(selectReachableWorkerPaneKeys(removed, WT).has(paneKey)).toBe(false)
})
