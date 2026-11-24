// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalPaneLayoutNode } from '../../../../../../shared/workspace-layout/terminal-tab-types'

const owner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.isMain
  }
}))
// The pane's running-process probe answers when the test says so.
const probe = vi.hoisted(() => ({ resolve: (_verdict: string) => {} }))
vi.mock('../../../terminal/tab-lifecycle/pty-running-work-probe', () => ({
  probePtyRunningWork: () =>
    new Promise((resolve) => {
      probe.resolve = (verdict) => resolve([{ ptyId: 'pty-user', verdict }])
    })
}))
// The two destructive boundaries this test watches: main's pane close and the window's own.
const sent = vi.hoisted(() => ({ toMain: vi.fn(() => true) }))
vi.mock('./layout-owner-pane-close-command', () => ({
  sendUserPaneCloseToLayoutOwner: sent.toMain
}))
vi.mock('../../mounting/terminal-pane-notice-retirement', () => ({
  captureTerminalPaneNoticeRetirement: () => undefined
}))

import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { useTerminalPaneCloseActions } from './use-terminal-pane-close-actions'

const WORKER_LEAF = '00000000-0000-4000-8000-000000000001'
const USER_LEAF = '00000000-0000-4000-8000-000000000002'
const OTHER_LEAF = '00000000-0000-4000-8000-000000000003'
const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (a: string, b: string): TerminalPaneLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first: leaf(a),
  second: leaf(b)
})

const stampedTab: Tab = makeUnifiedTab({
  id: 'tab',
  worktreeId: 'wt',
  groupId: 'pane',
  workerTab: {
    origin: {
      runId: 'run',
      dispatchId: 'dispatch',
      taskId: 'task',
      workerLeafId: WORKER_LEAF,
      parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
      coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
    }
  }
})

function setRoot(root: TerminalPaneLayoutNode): void {
  useAppStore.setState({
    terminalLayoutsByTabId: { tab: { root, activeLeafId: USER_LEAF, expandedLeafId: null } }
  })
}

function mount() {
  const manager = {
    getPanes: () => [{ id: 1 }, { id: 2 }],
    getActivePane: () => ({ id: 1 }),
    getLeafId: (paneId: number) => (paneId === 1 ? USER_LEAF : OTHER_LEAF),
    closePane: vi.fn()
  }
  const transport = { getPtyId: () => 'pty-user' }
  let confirmation: unknown = null
  const controller = {
    tabId: 'tab',
    worktreeId: 'wt',
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map([[1, transport]]) },
    get pendingCloseConfirmation() {
      return confirmation
    },
    setPendingCloseConfirmation: (next: unknown) => {
      confirmation = next
    },
    onCloseTab: vi.fn(),
    clearSessionRestoredBannerForPane: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBindingForLeaf: vi.fn(),
    updateSettings: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the controller fields the close path reads.
  const double = controller as unknown as Parameters<typeof useTerminalPaneCloseActions>[0]
  const { result, rerender } = renderHook(() => useTerminalPaneCloseActions(double))
  const closed = () => manager.closePane.mock.calls.length + sent.toMain.mock.calls.length
  return { result, rerender, closed, confirmation: () => confirmation }
}

beforeEach(() => {
  sent.toMain.mockClear()
  useAppStore.setState({
    workerTabsMode: 'open-when-clicked',
    unifiedTabsByWorktree: { wt: [stampedTab] },
    groupsByWorktree: {
      wt: [makeTabGroup({ id: 'pane', worktreeId: 'wt', activeTabId: 'tab', tabOrder: ['tab'] })]
    },
    settings: {
      ...useAppStore.getState().settings!,
      skipCloseTerminalWithRunningProcessConfirm: false
    }
  })
})

describe.each([false, true])('layout owner is main: %s', (isMain) => {
  beforeEach(() => {
    owner.isMain = isMain
  })

  it('Cmd/Ctrl+W admitted on an ordinary tab is refused when the probe finds it holding a worker', async () => {
    // The stamp's worker pane is gone: an ordinary tab when the shortcut is pressed.
    setRoot(split(USER_LEAF, OTHER_LEAF))
    const pane = mount()
    act(() => pane.result.current.handleKeyboardRequestClosePane(1))
    // The worker's pane is back before the probe answers that the process exited.
    setRoot(split(USER_LEAF, WORKER_LEAF))
    await act(async () => probe.resolve('exited'))
    expect(pane.closed()).toBe(0)
  })

  it('Cmd/Ctrl+W confirmed after the tab turned mixed sends no close; Cancel sends none either', async () => {
    setRoot(split(USER_LEAF, OTHER_LEAF))
    const pane = mount()
    act(() => pane.result.current.handleKeyboardRequestClosePane(1))
    await act(async () => probe.resolve('running'))
    expect(pane.confirmation()).not.toBeNull()
    setRoot(split(USER_LEAF, WORKER_LEAF))
    pane.rerender()
    act(() => pane.result.current.handleConfirmClose(false))
    expect(pane.closed()).toBe(0)
    act(() => pane.result.current.handleCancelClose())
    expect(pane.closed()).toBe(0)
  })

  it('an ordinary Cmd/Ctrl+W still closes the pane once the probe answers', async () => {
    setRoot(split(USER_LEAF, OTHER_LEAF))
    const pane = mount()
    act(() => pane.result.current.handleKeyboardRequestClosePane(1))
    await act(async () => probe.resolve('exited'))
    expect(pane.closed()).toBe(1)
  })
})
