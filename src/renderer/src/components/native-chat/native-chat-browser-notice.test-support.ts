import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const initial = useAppStore.getInitialState()

export function noticePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'browser-1',
    worktreeId: 'worktree-1',
    url: 'https://example.com/docs',
    title: 'Project docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

export function noticeWorkspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    ...noticePage(),
    id: 'browser-1',
    activePageId: 'page-1',
    pageIds: ['page-1'],
    ...overrides
  }
}

export function noticeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'browser-tab',
    entityId: 'browser-1',
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    contentType: 'browser',
    label: 'Browser',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

export function noticeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    hostId: 'local',
    path: '/workspace/project',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Project',
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

export function seedBrowserNotice(overrides: Partial<AppState> = {}): AppState {
  useAppStore.setState(
    {
      ...initial,
      activeWorktreeId: 'worktree-1',
      activeGroupIdByWorktree: { 'worktree-1': 'group-1' },
      worktreesByRepo: { 'repo-1': [noticeWorktree()] },
      browserTabsByWorktree: { 'worktree-1': [noticeWorkspace()] },
      browserPagesByWorkspace: { 'browser-1': [noticePage()] },
      unifiedTabsByWorktree: {
        'worktree-1': [
          noticeTab(),
          noticeTab({ id: 'chat-1', entityId: 'session-1', contentType: 'agent-session' })
        ]
      },
      groupsByWorktree: {
        'worktree-1': [
          {
            id: 'group-1',
            worktreeId: 'worktree-1',
            activeTabId: 'chat-1',
            tabOrder: ['chat-1', 'browser-tab']
          }
        ]
      },
      ...overrides
    },
    true
  )
  return useAppStore.getState()
}
