// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, seedStore } from '../../store/slices/store-test-helpers'
import type { TestStore } from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { guardRunningTerminalGroupClose } from '@/components/terminal/running-terminal-close-guard'
import { useFloatingTerminalCloseActions } from './use-floating-terminal-close-actions'

const storeBox = vi.hoisted(() => {
  const box: { store: TestStore | null } = { store: null }
  return box
})
const inspectRuntimeTerminalProcess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))
vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ inspectRuntimeTerminalProcess }))

// Why: the store API fixture replaces window, but renderHook needs the real DOM window.
const browserWindow = window
const mockApi = createStoreCascadesMockApi()
globalThis.window = browserWindow
Object.defineProperty(window, 'api', { configurable: true, value: mockApi })

function floatingCloseFixture() {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, { settings: getDefaultSettings('/tmp') })
  const first = store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)
  const second = store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)
  store.getState().setTabCustomTitle(first.id, 'First shell')
  store.getState().setTabCustomTitle(second.id, 'Second shell')
  const pane = store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
  if (!pane) {
    throw new Error('Expected floating pane')
  }
  const clusterId = store.getState().createTabCluster(pane.id, [first.id, second.id], {
    name: 'Build',
    color: 'blue'
  })
  if (!clusterId) {
    throw new Error('Expected terminal cluster')
  }
  store.getState().setTabClusterCollapsed(pane.id, clusterId, true)
  store.setState({
    ptyIdsByTabId: { [first.id]: ['pty-first'], [second.id]: ['pty-second'] }
  })
  const state = store.getState()
  const activeGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
  const cluster = activeGroup?.tabClusters?.[0]
  if (!activeGroup || !cluster) {
    throw new Error('Expected collapsed terminal cluster')
  }
  const { result } = renderHook(() =>
    useFloatingTerminalCloseActions({
      closeTab: state.closeTab,
      closeBrowserTab: state.closeBrowserTab,
      closeFile: state.closeFile,
      closeUnifiedTab: state.closeUnifiedTab,
      activeGroup,
      groupTabs: state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [],
      pendingReclaimArmByFileIdRef: { current: new Map<string, () => void>() },
      queueEditorCloseRequests: vi.fn()
    })
  )
  return { store, first, second, cluster, actions: result.current }
}

beforeEach(() => {
  vi.clearAllMocks()
  inspectRuntimeTerminalProcess.mockResolvedValue({
    foregroundProcess: 'sleep',
    hasChildProcesses: true
  })
})

afterEach(() => {
  cleanup()
  const confirmation = useRunningTerminalCloseConfirmStore.getState()
  vi.useFakeTimers()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm) {
    vi.advanceTimersByTime(350)
    confirmation.dismissRunningTerminalClose()
  }
  vi.useRealTimers()
})

describe('floating terminal group closes', () => {
  it('records every member for reopen after one running-process confirmation', async () => {
    const { store, first, second, cluster, actions } = floatingCloseFixture()
    act(() => {
      guardRunningTerminalGroupClose({
        subjectKey: `tab-cluster:${cluster.id}`,
        groupLabel: cluster.name,
        terminals: [first, second].map((tab) => ({ terminalTabId: tab.id, tabLabel: tab.title })),
        onClose: () => actions.closeFloatingClusterConfirmed(cluster.tabIds)
      })
    })
    await vi.waitFor(() => {
      expect(
        useRunningTerminalCloseConfirmStore
          .getState()
          .runningTerminalCloseConfirm?.groupTerminals?.map((terminal) => terminal.terminalTabId)
      ).toEqual([first.id, second.id])
    })
    expect(
      store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map((tab) => tab.id)
    ).toEqual([first.id, second.id])

    act(() => useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose())

    const closed = store.getState()
    expect(closed.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([])
    expect(closed.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([])
    expect(
      closed.recentlyClosedTerminalTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map(
        (snapshot) => snapshot.customTitle
      )
    ).toEqual(['Second shell', 'First shell'])
    expect(closed.recentlyClosedTabKindsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      'terminal',
      'terminal'
    ])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()

    expect(closed.reopenClosedTab(FLOATING_TERMINAL_WORKTREE_ID)).toBe(true)
    const reopened = store.getState()
    expect(reopened.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      expect.objectContaining({ customTitle: 'Second shell', ptyId: null })
    ])
    expect(reopened.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]?.id).not.toBe(second.id)
    expect(
      reopened.recentlyClosedTerminalTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map(
        (snapshot) => snapshot.customTitle
      )
    ).toEqual(['First shell'])
  })

  it('keeps Close Others out of reopen history, including hidden cluster members', () => {
    const { store, actions } = floatingCloseFixture()
    const keeper = store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)

    act(() => actions.closeOthers(keeper.id))

    const state = store.getState()
    expect(state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      keeper.id
    ])
    expect(
      state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map((tab) => tab.entityId)
    ).toEqual([keeper.id])
    expect(
      state.recentlyClosedTerminalTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    ).toBeUndefined()
    expect(state.recentlyClosedTabKindsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBeUndefined()
    expect(state.reopenClosedTab(FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })
})
