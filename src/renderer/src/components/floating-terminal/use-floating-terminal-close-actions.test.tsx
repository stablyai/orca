// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { guardRunningTerminalGroupClose } from '@/components/terminal/running-terminal-close-guard'
import { useTabGroupWorkspaceModel } from '@/components/tab-group/useTabGroupWorkspaceModel'
import { useFloatingTerminalCloseActions } from './use-floating-terminal-close-actions'

const storeBox = vi.hoisted(() => {
  const box: { store: TestStore | null } = { store: null }
  return box
})
let store: TestStore
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

// Why: the store API fixture replaces window, but hooks need the real DOM window.
const browserWindow = window
const mockApi = createStoreCascadesMockApi()
globalThis.window = browserWindow
Object.defineProperty(window, 'api', { configurable: true, value: mockApi })

const requestEditorFileClose = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/editor-autosave', () => ({ requestEditorFileClose }))

const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
const groupId = 'floating-group'
const sharedFileId = 'shared-file'
const editor = makeUnifiedTab({
  id: 'editor-one',
  worktreeId,
  groupId,
  contentType: 'editor',
  entityId: sharedFileId
})
const secondReference = makeUnifiedTab({
  id: 'editor-two',
  worktreeId,
  groupId: 'other-group',
  contentType: 'editor',
  entityId: sharedFileId
})
const chat = makeUnifiedTab({
  id: 'chat-one',
  worktreeId,
  groupId,
  contentType: 'agent-session',
  entityId: 'chat-session'
})
const pinnedEditor = makeUnifiedTab({
  id: 'pinned-editor',
  worktreeId,
  groupId,
  contentType: 'editor',
  entityId: 'pinned-file',
  isPinned: true
})
const group = makeTabGroup({
  id: groupId,
  worktreeId,
  activeTabId: editor.id,
  tabOrder: [editor.id, chat.id]
})

const closeFile = vi.fn<AppState['closeFile']>()
const closeUnifiedTab = vi.fn<AppState['closeUnifiedTab']>(() => null)
const requestPinnedTabCloseConfirm = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
  storeBox.store = store
  inspectRuntimeTerminalProcess.mockResolvedValue({
    foregroundProcess: 'sleep',
    hasChildProcesses: true
  })
  seedStore(store, { settings: getDefaultSettings('/tmp') })
  store.setState({
    closeFile,
    closeUnifiedTab,
    requestPinnedTabCloseConfirm,
    unifiedTabsByWorktree: { [worktreeId]: [editor, chat, secondReference] },
    groupsByWorktree: { [worktreeId]: [group] },
    activeGroupIdByWorktree: { [worktreeId]: groupId },
    openFiles: [makeOpenFile({ id: sharedFileId, worktreeId })]
  })
})

afterEach(() => {
  cleanup()
  vi.useFakeTimers()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm) {
    vi.advanceTimersByTime(350)
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  }
  vi.useRealTimers()
})

function actions(groupTabs = [editor, chat]) {
  return renderHook(() => useFloatingTerminalCloseActions({ activeGroup: group, groupTabs })).result
    .current
}

function setPinnedConfirmation(confirmClosePinnedTab: boolean) {
  const settings = store.getState().settings ?? getDefaultSettings(process.cwd())
  store.setState({ settings: { ...settings, confirmClosePinnedTab } })
}

describe('floating titlebar close actions', () => {
  it('closes one editor reference while keeping its shared open file', () => {
    actions().closeFloatingItemConfirmed(editor.id)

    expect(closeFile).not.toHaveBeenCalled()
    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
  })

  it('closes editor tabs without closing structured chats from Close All Editor Tabs', () => {
    actions().closeAllFiles()

    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
    expect(closeUnifiedTab).not.toHaveBeenCalledWith(chat.id)
    expect(closeFile).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'retains pinned editors without prompting during Close All Editor Tabs (confirmation %s)',
    (confirmClosePinnedTab) => {
      setPinnedConfirmation(confirmClosePinnedTab)
      store.setState({
        unifiedTabsByWorktree: { [worktreeId]: [editor, pinnedEditor, chat] },
        openFiles: [
          makeOpenFile({ id: sharedFileId, worktreeId }),
          makeOpenFile({ id: 'pinned-file', worktreeId })
        ]
      })

      actions([editor, pinnedEditor, chat]).closeAllFiles()

      expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
      expect(closeUnifiedTab).not.toHaveBeenCalledWith(pinnedEditor.id)
      expect(closeUnifiedTab).not.toHaveBeenCalledWith(chat.id)
      expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    }
  )

  it('keeps the confirmation policy for an explicit pinned editor close', () => {
    setPinnedConfirmation(true)
    store.setState({
      unifiedTabsByWorktree: { [worktreeId]: [pinnedEditor] },
      openFiles: [makeOpenFile({ id: 'pinned-file', worktreeId })]
    })

    actions([pinnedEditor]).closeFloatingItemConfirmed(pinnedEditor.id)

    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledOnce()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    requestPinnedTabCloseConfirm.mock.calls[0]?.[0].onConfirm()
    expect(closeUnifiedTab).toHaveBeenCalledWith(pinnedEditor.id)
  })

  it('routes a dirty last reference through the shared save confirmation', () => {
    store.setState({
      unifiedTabsByWorktree: { [worktreeId]: [editor] },
      openFiles: [makeOpenFile({ id: sharedFileId, worktreeId, isDirty: true })]
    })

    actions().closeFloatingItemConfirmed(editor.id)

    expect(requestEditorFileClose).toHaveBeenCalledWith(sharedFileId, {
      onClosed: expect.any(Function)
    })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('reopens every collapsed group member after one running-process confirmation through shared commands', async () => {
    store = createTestStore()
    storeBox.store = store
    seedStore(store, { settings: getDefaultSettings('/tmp') })
    const first = store.getState().createTab(worktreeId)
    const second = store.getState().createTab(worktreeId)
    store.getState().setTabCustomTitle(first.id, 'First shell')
    store.getState().setTabCustomTitle(second.id, 'Second shell')
    const pane = store.getState().groupsByWorktree[worktreeId]?.[0]
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
    const activeGroup = store.getState().groupsByWorktree[worktreeId]?.[0]
    const cluster = activeGroup?.tabClusters?.[0]
    if (!activeGroup || !cluster) {
      throw new Error('Expected collapsed terminal cluster')
    }
    const { result } = renderHook(() =>
      useTabGroupWorkspaceModel({ groupId: activeGroup.id, worktreeId })
    )

    act(() => {
      guardRunningTerminalGroupClose({
        subjectKey: `tab-cluster:${cluster.id}`,
        groupLabel: cluster.name,
        terminals: [first, second].map((tab) => ({ terminalTabId: tab.id, tabLabel: tab.title })),
        onClose: () => result.current.commands.closeMany(cluster.tabIds)
      })
    })
    await vi.waitFor(() => {
      expect(
        useRunningTerminalCloseConfirmStore
          .getState()
          .runningTerminalCloseConfirm?.groupTerminals?.map((terminal) => terminal.terminalTabId)
      ).toEqual([first.id, second.id])
    })
    expect(store.getState().tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      first.id,
      second.id
    ])

    act(() => useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose())

    const closed = store.getState()
    expect(closed.tabsByWorktree[worktreeId]).toEqual([])
    expect(closed.unifiedTabsByWorktree[worktreeId]).toEqual([])
    expect(
      closed.recentlyClosedTerminalTabsByWorktree[worktreeId]?.map(
        (snapshot) => snapshot.customTitle
      )
    ).toEqual(['Second shell', 'First shell'])
    expect(closed.recentlyClosedTabKindsByWorktree[worktreeId]).toEqual(['terminal', 'terminal'])
    expect(inspectRuntimeTerminalProcess).toHaveBeenCalledTimes(2)
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()

    act(() => {
      expect(closed.reopenClosedTab(worktreeId)).toBe(true)
    })
    const reopened = store.getState()
    expect(reopened.tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ customTitle: 'Second shell', ptyId: null })
    ])
    expect(reopened.tabsByWorktree[worktreeId]?.[0]?.id).not.toBe(second.id)
    expect(
      reopened.recentlyClosedTerminalTabsByWorktree[worktreeId]?.map(
        (snapshot) => snapshot.customTitle
      )
    ).toEqual(['First shell'])

    act(() => {
      expect(reopened.reopenClosedTab(worktreeId)).toBe(true)
    })
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ customTitle: 'Second shell', ptyId: null }),
      expect.objectContaining({ customTitle: 'First shell', ptyId: null })
    ])
    expect(store.getState().tabsByWorktree[worktreeId]?.[1]?.id).not.toBe(first.id)
  })
})
