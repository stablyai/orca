// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabContentType } from '../../../shared/tab-types'
import { createTestStore, makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'
import { handleFocusTabGroup } from './ipc-tab-group-focus'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  focusTerminal: vi.fn(),
  focusBrowser: vi.fn(),
  focusAgent: vi.fn()
}))

vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminal
}))
vi.mock('@/components/browser-pane/host-guest/browser-focus', () => ({
  requestBrowserFocus: mocks.focusBrowser
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.focusAgent
}))

const WORKSPACE = 'folder-workspace'

function splitStore(contentType: TabContentType = 'terminal') {
  const store = createTestStore()
  store.setState({
    activeWorktreeId: WORKSPACE,
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeTabId: 'left-terminal',
    activeGroupIdByWorktree: { [WORKSPACE]: 'left' },
    groupsByWorktree: {
      [WORKSPACE]: [
        makeTabGroup({
          id: 'right',
          worktreeId: WORKSPACE,
          activeTabId: 'right-tab',
          tabOrder: ['right-tab']
        }),
        makeTabGroup({
          id: 'left',
          worktreeId: WORKSPACE,
          activeTabId: 'left-tab',
          tabOrder: ['left-tab']
        })
      ]
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({
          id: 'left-tab',
          entityId: 'left-terminal',
          groupId: 'left',
          worktreeId: WORKSPACE
        }),
        makeUnifiedTab({
          id: 'right-tab',
          entityId: 'right-entity',
          groupId: 'right',
          worktreeId: WORKSPACE,
          contentType
        })
      ]
    },
    layoutByWorktree: {
      [WORKSPACE]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      }
    }
  })
  mocks.getState.mockImplementation(store.getState)
  return store
}

function browserStore() {
  const store = splitStore('browser')
  const workspace = {
    id: 'right-entity',
    worktreeId: WORKSPACE,
    url: 'about:blank',
    title: 'Browser',
    activePageId: 'right-page',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  store.setState({
    browserTabsByWorktree: { [WORKSPACE]: [workspace] },
    browserPagesByWorkspace: {
      [workspace.id]: [{ ...workspace, id: 'right-page', workspaceId: workspace.id }]
    }
  })
  return store
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => document.body.replaceChildren())

describe('keyboard focus between split tab groups', () => {
  it('reproduces split-local tab shortcuts having nowhere to navigate', () => {
    const store = splitStore()
    for (const cycle of [handleSwitchTab, handleSwitchTabAcrossAllTypes, handleSwitchTerminalTab]) {
      expect(cycle(1)).toBe(false)
    }
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
  })

  it('focuses the next group in layout order rather than creation order, then wraps', () => {
    const store = splitStore()
    expect(handleFocusTabGroup(1)).toBe(true)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('right')
    expect(mocks.focusTerminal).toHaveBeenLastCalledWith('right-entity', null, {
      onlyIfFocusUnclaimed: true
    })
    expect(handleFocusTabGroup(1)).toBe(true)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
    expect(handleFocusTabGroup(-1)).toBe(true)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('right')
  })

  it('keeps a single group unchanged', () => {
    const store = splitStore()
    store.setState({ layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: 'left' } } })
    expect(handleFocusTabGroup(1)).toBe(false)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
  })

  it('uses the existing structured-session activation for an agent group', () => {
    splitStore('agent-session')
    expect(handleFocusTabGroup(1)).toBe(true)
    expect(mocks.focusAgent).toHaveBeenCalledWith({ worktreeId: WORKSPACE, tabId: 'right-tab' })
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
  })

  it('hands an editor group the DOM focus and releases the retained terminal input', async () => {
    splitStore('editor')
    const source = document.createElement('textarea')
    source.className = 'xterm-helper-textarea'
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'right'
    body.dataset.worktreeId = WORKSPACE
    const editor = document.createElement('textarea')
    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    monaco.append(editor)
    body.append(monaco)
    document.body.append(source, body)
    source.focus()

    expect(handleFocusTabGroup(1)).toBe(true)
    expect(document.activeElement).not.toBe(source)
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
  })

  it('restores the selected browser page through the existing focus request', () => {
    browserStore()
    expect(handleFocusTabGroup(1)).toBe(true)
    expect(mocks.focusBrowser).toHaveBeenCalledWith({ pageId: 'right-page', target: 'webview' })
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
  })

  it('starts a guest shortcut from its source group even when the renderer selection is stale', () => {
    const store = browserStore()
    expect(handleFocusTabGroup(-1, 'right-page')).toBe(true)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
    expect(mocks.focusTerminal).toHaveBeenCalledWith('left-terminal', null, {
      onlyIfFocusUnclaimed: true
    })
    expect(mocks.focusBrowser).not.toHaveBeenCalled()
  })

  it('ignores a retired guest source instead of navigating from an unrelated selection', () => {
    const store = browserStore()
    expect(handleFocusTabGroup(1, 'removed-page')).toBe(false)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
    expect(mocks.focusBrowser).not.toHaveBeenCalled()
  })

  it('does not switch workspaces for a guest source outside the active workspace', () => {
    const store = browserStore()
    store.setState({ activeWorktreeId: 'different-workspace' })
    expect(handleFocusTabGroup(1, 'right-page')).toBe(false)
    expect(store.getState().activeWorktreeId).toBe('different-workspace')
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
    expect(mocks.focusBrowser).not.toHaveBeenCalled()
  })

  it('does not let a queued editor handoff reclaim a group after another navigation', async () => {
    const store = splitStore('editor')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'right'
    body.dataset.worktreeId = WORKSPACE
    const editor = document.createElement('textarea')
    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    monaco.append(editor)
    body.append(monaco)
    document.body.append(body)

    handleFocusTabGroup(1)
    handleFocusTabGroup(1)
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('left')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(document.activeElement).not.toBe(editor)
  })
})
