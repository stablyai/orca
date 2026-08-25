import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { OpenFile } from '../store/slices/editor'
import type { Tab } from '../../../shared/tab-types'
import { recordWebSessionBrowserPlacement } from './web-session-browser-placement'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const EDITOR_GROUP = 'client-editor-group'
const PREVIEW_GROUP = 'client-preview-group'
const UNRELATED_EDITOR_GROUP = 'unrelated-editor-group'
const EDITOR_FILE_ID = '/repo/paired-html-focus.html'
const EDITOR_TAB_ID = 'local-html-editor'
const UNRELATED_EDITOR_FILE_ID = '/repo/unrelated.html'
const UNRELATED_EDITOR_TAB_ID = 'unrelated-html-editor'
const HOST_TERMINAL_PARENT = 'host-terminal'
const HOST_TERMINAL_SURFACE = `${HOST_TERMINAL_PARENT}::${LEAF_ID}`
const HOST_BROWSER_TAB = 'host-html-browser-tab'
const HOST_BROWSER_PAGE = 'host-html-browser-page'

function htmlOpenFile(): OpenFile {
  return {
    id: EDITOR_FILE_ID,
    filePath: EDITOR_FILE_ID,
    relativePath: 'paired-html-focus.html',
    worktreeId: WT,
    language: 'html',
    isDirty: false,
    runtimeEnvironmentId: ENV,
    mode: 'edit'
  }
}

function htmlEditorTab(): Tab {
  return {
    id: EDITOR_TAB_ID,
    entityId: EDITOR_FILE_ID,
    groupId: EDITOR_GROUP,
    worktreeId: WT,
    contentType: 'editor',
    label: 'paired-html-focus.html',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: NOW,
    isPreview: false,
    isPinned: false
  }
}

function unrelatedEditorTab(): Tab {
  return {
    ...htmlEditorTab(),
    id: UNRELATED_EDITOR_TAB_ID,
    entityId: UNRELATED_EDITOR_FILE_ID,
    groupId: UNRELATED_EDITOR_GROUP,
    label: 'unrelated.html'
  }
}

function mirroredTerminalTab(terminalTabId: string): Tab {
  return {
    id: terminalTabId,
    entityId: terminalTabId,
    groupId: EDITOR_GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: 'host shell',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    isPreview: false,
    isPinned: false
  }
}

function editorFocusedSplitState(activeGroupId: string): WebSessionTabsSyncState {
  const terminalTabId = toWebTerminalSurfaceTabId(HOST_TERMINAL_PARENT)
  const editorTab = htmlEditorTab()
  const unrelatedTab = unrelatedEditorTab()
  const openFile = htmlOpenFile()
  const unrelatedOpenFile = {
    ...openFile,
    id: UNRELATED_EDITOR_FILE_ID,
    filePath: UNRELATED_EDITOR_FILE_ID,
    relativePath: 'unrelated.html'
  }
  return makeState({
    activeFileId: openFile.id,
    activeFileIdByWorktree: { [WT]: openFile.id },
    activeGroupIdByWorktree: { [WT]: activeGroupId },
    activeTabId: terminalTabId,
    activeTabIdByWorktree: { [WT]: terminalTabId },
    activeTabType: 'editor',
    activeTabTypeByWorktree: { [WT]: 'editor' },
    openFiles: [unrelatedOpenFile, openFile],
    tabsByWorktree: {
      [WT]: [
        {
          id: terminalTabId,
          ptyId: 'remote:web-env-1@@terminal-1',
          worktreeId: WT,
          title: 'host shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW
        }
      ]
    },
    unifiedTabsByWorktree: {
      [WT]: [unrelatedTab, mirroredTerminalTab(terminalTabId), editorTab]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: UNRELATED_EDITOR_GROUP,
          worktreeId: WT,
          activeTabId: unrelatedTab.id,
          tabOrder: [unrelatedTab.id],
          recentTabIds: [unrelatedTab.id]
        },
        {
          id: EDITOR_GROUP,
          worktreeId: WT,
          activeTabId: editorTab.id,
          tabOrder: [terminalTabId, editorTab.id],
          recentTabIds: [terminalTabId, editorTab.id]
        },
        {
          id: PREVIEW_GROUP,
          worktreeId: WT,
          activeTabId: null,
          tabOrder: []
        }
      ]
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: UNRELATED_EDITOR_GROUP },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: EDITOR_GROUP },
          second: { type: 'leaf', groupId: PREVIEW_GROUP },
          ratio: 0.5
        },
        ratio: 0.5
      }
    }
  })
}

function unfocusedHtmlPreviewSnapshot() {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_TERMINAL_SURFACE,
        title: 'host shell',
        parentTabId: HOST_TERMINAL_PARENT,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      },
      {
        type: 'browser',
        id: HOST_BROWSER_TAB,
        title: 'paired-html-focus.html',
        browserWorkspaceId: 'host-html-workspace',
        browserPageId: HOST_BROWSER_PAGE,
        url: 'file:///repo/paired-html-focus.html',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      }
    ],
    {
      activeGroupId: 'host-group-1',
      activeTabId: HOST_TERMINAL_SURFACE,
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: 'host-group-1',
          activeTabId: HOST_TERMINAL_PARENT,
          tabOrder: [HOST_TERMINAL_PARENT, HOST_BROWSER_TAB]
        }
      ]
    }
  )
}

function previewFocus(state: WebSessionTabsSyncState): {
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: WebSessionTabsSyncState['activeTabType'] | null
} {
  const activeGroup = (state.groupsByWorktree[WT] ?? []).find(
    (group) => group.id === state.activeGroupIdByWorktree[WT]
  )
  return {
    activeGroupId: activeGroup?.id ?? null,
    activeTabId: activeGroup?.activeTabId ?? null,
    activeTabType: state.activeTabTypeByWorktree[WT] ?? null
  }
}

describe('applyWebSessionTabsSnapshot — unfocused HTML side preview', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps the source editor focused when the empty preview split is still the active group', () => {
    // Why: Open Preview to the Side creates the right-hand group first. Until the
    // host browser lands, that group is empty — a host snapshot with terminal still
    // active must not treat that emptiness as "the user focused a terminal".
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: HOST_BROWSER_PAGE,
      groupId: PREVIEW_GROUP,
      sourceGroupId: EDITOR_GROUP,
      focusOwner: { environmentId: ENV },
      callerCreatedGroup: true
    })
    const state = editorFocusedSplitState(PREVIEW_GROUP)

    const patch = applyWebSessionTabsSnapshot(
      state,
      unfocusedHtmlPreviewSnapshot(),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    const next = { ...state, ...patch }

    expect(previewFocus(next)).toEqual({
      activeGroupId: EDITOR_GROUP,
      activeTabId: EDITOR_TAB_ID,
      activeTabType: 'editor'
    })
    expect(
      next.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'browser')
    ).toMatchObject({ id: HOST_BROWSER_TAB, groupId: PREVIEW_GROUP })
  })

  it('still follows a host terminal snapshot when the empty split is not a reserved preview', () => {
    const state = editorFocusedSplitState(PREVIEW_GROUP)

    const patch = applyWebSessionTabsSnapshot(
      state,
      unfocusedHtmlPreviewSnapshot(),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    const next = { ...state, ...patch }

    expect(previewFocus(next).activeGroupId).not.toBe(EDITOR_GROUP)
    expect(previewFocus(next).activeTabType).toBe('editor')
  })

  it('does not fall back to an unrelated editor after the source group closes', () => {
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: HOST_BROWSER_PAGE,
      groupId: PREVIEW_GROUP,
      sourceGroupId: EDITOR_GROUP,
      focusOwner: { environmentId: ENV },
      callerCreatedGroup: true
    })
    const state = editorFocusedSplitState(PREVIEW_GROUP)
    state.groupsByWorktree = {
      [WT]: (state.groupsByWorktree[WT] ?? []).filter((group) => group.id !== EDITOR_GROUP)
    }
    state.unifiedTabsByWorktree = {
      [WT]: (state.unifiedTabsByWorktree[WT] ?? []).filter((tab) => tab.groupId !== EDITOR_GROUP)
    }
    state.openFiles = state.openFiles.filter((file) => file.id !== EDITOR_FILE_ID)
    state.layoutByWorktree = {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: UNRELATED_EDITOR_GROUP },
        second: { type: 'leaf', groupId: PREVIEW_GROUP },
        ratio: 0.5
      }
    }

    const patch = applyWebSessionTabsSnapshot(
      state,
      unfocusedHtmlPreviewSnapshot(),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    const next = { ...state, ...patch }

    expect(previewFocus(next).activeGroupId).not.toBe(UNRELATED_EDITOR_GROUP)
    expect(previewFocus(next).activeTabId).not.toBe(UNRELATED_EDITOR_TAB_ID)
  })

  it('keeps the source editor focused when the editor group is still active', () => {
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: HOST_BROWSER_PAGE,
      groupId: PREVIEW_GROUP,
      sourceGroupId: EDITOR_GROUP,
      focusOwner: { environmentId: ENV },
      callerCreatedGroup: true
    })
    const state = editorFocusedSplitState(EDITOR_GROUP)

    const patch = applyWebSessionTabsSnapshot(
      state,
      unfocusedHtmlPreviewSnapshot(),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    const next = { ...state, ...patch }

    expect(previewFocus(next)).toEqual({
      activeGroupId: EDITOR_GROUP,
      activeTabId: EDITOR_TAB_ID,
      activeTabType: 'editor'
    })
  })
})
