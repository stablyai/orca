// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('./worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateBrowserPagePaletteResult } from './browser-page-palette-activation'

const initialAppState = useAppStore.getInitialState()

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Palette Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'project-1',
    name: 'Remote folder',
    folderPath: '/workspace/folder-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeWorkspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    id: 'ws-1',
    worktreeId: 'wt-1',
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function makePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    url: 'https://example.com/docs',
    title: 'Project Docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function makeBrowserTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-browser-1',
    entityId: 'ws-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'browser',
    label: 'Example',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: 'unified-browser-1',
    tabOrder: ['unified-browser-1'],
    ...overrides
  }
}

function seedStore(overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialAppState,
      worktreesByRepo: { 'repo-1': [makeWorktree()] },
      browserTabsByWorktree: { 'wt-1': [makeWorkspace()] },
      browserPagesByWorkspace: { 'ws-1': [makePage()] },
      unifiedTabsByWorktree: { 'wt-1': [makeBrowserTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeWorktreeId: 'wt-1',
      ...overrides
    } as AppState,
    true
  )
}

const target = { pageId: 'page-1', workspaceId: 'ws-1', worktreeId: 'wt-1' }

describe('activateBrowserPagePaletteResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    seedStore()
  })

  it('activates the browser workspace and page', () => {
    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'activated',
      pageId: 'page-1',
      focusTarget: 'webview'
    })

    const state = useAppStore.getState()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {})
    expect(state.activeBrowserTabId).toBe('ws-1')
    expect(state.activeTabType).toBe('browser')
    expect(state.browserTabsByWorktree['wt-1'][0].activePageId).toBe('page-1')
  })

  it('threads the worktree execution host into worktree activation', () => {
    seedStore({
      worktreesByRepo: { 'repo-1': [makeWorktree({ hostId: 'ssh:host-1' })] }
    })

    activateBrowserPagePaletteResult(target)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'ssh:host-1'
    })
  })

  it('activates pages in remote folder workspaces', () => {
    const worktreeId = folderWorkspaceKey('folder-1')
    seedStore({
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace({ executionHostId: 'ssh:host-1' })],
      browserTabsByWorktree: { [worktreeId]: [makeWorkspace({ worktreeId })] },
      browserPagesByWorkspace: { 'ws-1': [makePage({ worktreeId })] }
    })

    expect(
      activateBrowserPagePaletteResult({ pageId: 'page-1', workspaceId: 'ws-1', worktreeId })
    ).toMatchObject({ status: 'activated' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId, {
      executionHostId: 'ssh:host-1'
    })
  })

  it('derives the focus target from the page url captured before worktree activation', () => {
    seedStore({
      browserPagesByWorkspace: {
        'ws-1': [makePage({ url: ORCA_BROWSER_BLANK_URL })]
      }
    })
    // Why: the real activation drops the page, so a post-activation lookup would
    // resolve the wrong target — the pre-capture is what keeps this correct.
    mocks.activateAndRevealWorktree.mockImplementation(() => {
      useAppStore.setState({ browserPagesByWorkspace: {} })
      return true
    })

    expect(activateBrowserPagePaletteResult(target)).toMatchObject({
      status: 'activated',
      focusTarget: 'address-bar'
    })
  })

  it('reports a missing page or workspace as a stale target', () => {
    seedStore({ browserPagesByWorkspace: {} })
    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-page'
    })

    seedStore({ browserTabsByWorktree: {} })
    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-page'
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  // A live page in a dead workspace is a different story than a dead page.
  it('reports an absent worktree as a missing workspace', () => {
    seedStore({ worktreesByRepo: {} })

    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  // Deleting a worktree purges its browser workspaces and pages too, so the
  // worktree check must win or a dead workspace reads as a stale page.
  it('reports a deleted worktree as a missing workspace once its pages are purged', () => {
    seedStore({
      worktreesByRepo: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {}
    })

    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('reports a failed worktree activation distinguishably from a stale page', () => {
    mocks.activateAndRevealWorktree.mockReturnValue(false)

    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
    expect(useAppStore.getState().activeBrowserTabId).toBeNull()
  })
})

// U3: group focus already rides on setActiveBrowserTab → activateTab. These pin
// it so the extraction above cannot quietly lose cross-column jumping.
describe('activateBrowserPagePaletteResult group focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    seedStore()
  })

  it('focuses the owning group when the page lives in another split column', () => {
    seedStore({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeBrowserTab({
            id: 'unified-terminal-1',
            entityId: 'term-1',
            contentType: 'terminal'
          }),
          makeBrowserTab({ id: 'unified-browser-1', groupId: 'group-2' })
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          makeGroup({
            activeTabId: 'unified-terminal-1',
            tabOrder: ['unified-terminal-1']
          }),
          makeGroup({
            id: 'group-2',
            activeTabId: null,
            tabOrder: ['unified-browser-1']
          })
        ]
      },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' }
    })

    expect(activateBrowserPagePaletteResult(target).status).toBe('activated')

    const state = useAppStore.getState()
    expect(state.activeGroupIdByWorktree['wt-1']).toBe('group-2')
    expect(state.groupsByWorktree['wt-1'][1].activeTabId).toBe('unified-browser-1')
  })

  it('leaves the focused group unchanged when the page is already in it', () => {
    expect(activateBrowserPagePaletteResult(target).status).toBe('activated')

    expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe('group-1')
  })

  it('still activates the page when no unified tab backs the browser workspace', () => {
    seedStore({ unifiedTabsByWorktree: {}, groupsByWorktree: { 'wt-1': [] } })

    expect(activateBrowserPagePaletteResult(target)).toMatchObject({
      status: 'activated'
    })
    expect(useAppStore.getState().activeBrowserTabId).toBe('ws-1')
  })
})
