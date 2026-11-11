// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import '../../../../../shared/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn() }))

vi.mock('../../workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
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
    mocks.activateAndRevealWorkspace.mockReturnValue(true)
    seedStore()
  })

  it('rejects colliding child ids before mutating either host', () => {
    seedStore({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ hostId: 'ssh:host-1' })],
        'repo-2': [makeWorktree({ repoId: 'repo-2', hostId: 'ssh:host-2' })]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeBrowserTab({ executionHostId: 'ssh:host-1', groupId: 'group-host-1' }),
          makeBrowserTab({ executionHostId: 'ssh:host-2', groupId: 'group-host-2' })
        ]
      },
      groupsByWorktree: {
        'wt-1': [makeGroup({ id: 'group-host-1' }), makeGroup({ id: 'group-host-2' })]
      }
    })

    const before = useAppStore.getState()
    expect(activateBrowserPagePaletteResult({ ...target, executionHostId: 'ssh:host-2' })).toEqual({
      status: 'failed',
      reason: 'missing-tab'
    })
    expect(useAppStore.getState()).toBe(before)
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })

  it('derives the focus target from the page url captured before worktree activation', () => {
    seedStore({
      browserPagesByWorkspace: {
        'ws-1': [makePage({ url: ORCA_BROWSER_BLANK_URL })]
      }
    })
    // Capture the focus target before activation deletes the original page.
    mocks.activateAndRevealWorkspace.mockImplementation(() => {
      useAppStore.setState({ browserPagesByWorkspace: {} })
      return true
    })

    expect(activateBrowserPagePaletteResult(target)).toMatchObject({
      status: 'activated',
      focusTarget: 'address-bar'
    })
  })
})

// Preserve cross-column focus through setActiveBrowserTab → activateTab.
describe('activateBrowserPagePaletteResult group focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorkspace.mockReturnValue(true)
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

  // Without a unified tab, success would leave the previous tab visible.
  it('fails instead of activating when no unified tab backs the browser workspace', () => {
    seedStore({ unifiedTabsByWorktree: {}, groupsByWorktree: { 'wt-1': [] } })

    expect(activateBrowserPagePaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-tab'
    })
    expect(useAppStore.getState().activeBrowserTabId).toBeNull()
  })
})
