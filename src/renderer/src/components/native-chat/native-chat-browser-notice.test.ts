// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resolveOwner } from '@/lib/resolve-owner'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  nativeChatBrowserExternalUrl,
  createNativeChatBrowserNoticeSelector,
  selectNativeChatBrowserNotices
} from './native-chat-browser-notice'
import {
  noticePage,
  noticeTab,
  noticeWorkspace,
  noticeWorktree,
  seedBrowserNotice
} from './native-chat-browser-notice.test-support'

vi.mock('@/lib/resolve-owner', async (importOriginal) => {
  const original = await importOriginal<typeof ResolveOwnerModule>()
  return { ...original, resolveOwner: vi.fn(original.resolveOwner) }
})

beforeEach(() => seedBrowserNotice())
const targets = (ids: readonly string[] = ['page-1']) =>
  selectNativeChatBrowserNotices(useAppStore.getState(), 'chat-1', ids)

describe('browser notices owned by a chat workspace', () => {
  it('retains its targets and skips ownership resolution for unrelated streaming updates', () => {
    const select = createNativeChatBrowserNoticeSelector('chat-1', ['page-1'])
    const first = select(useAppStore.getState())
    const calls = vi.mocked(resolveOwner).mock.calls.length
    expect(first).toHaveLength(1)
    useAppStore.setState({ agentStatusByPaneKey: {} })
    expect(select(useAppStore.getState())).toBe(first)
    expect(vi.mocked(resolveOwner).mock.calls.length).toBe(calls)
    useAppStore.setState({ browserPagesByWorkspace: {} })
    expect(select(useAppStore.getState())).toEqual([])
    expect(vi.mocked(resolveOwner).mock.calls.length).toBeGreaterThan(calls)
  })
  it('keeps only observed, live pages belonging to the chat workspace', () => {
    expect(targets()).toEqual([{ page: noticePage(), executionHostId: 'local' }])
    expect(targets([])).toEqual([])
    useAppStore.setState({ browserPagesByWorkspace: { 'browser-1': [] } })
    expect(targets()).toEqual([])
  })

  it('does not borrow pages from another workspace when global focus moves there', () => {
    seedBrowserNotice({
      activeWorktreeId: 'other-worktree',
      activeWorkspaceExecutionHostId: 'runtime:other',
      browserTabsByWorktree: {
        'other-worktree': [noticeWorkspace({ worktreeId: 'other-worktree' })]
      }
    })
    expect(targets()).toEqual([])
  })

  it('does not expose an orphaned browser workspace or another host’s tab', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'worktree-1': [noticeTab({ id: 'chat-1', contentType: 'agent-session' })]
      }
    })
    expect(targets()).toEqual([])
    seedBrowserNotice({
      unifiedTabsByWorktree: {
        'worktree-1': [
          noticeTab({ executionHostId: 'ssh:other' }),
          noticeTab({ id: 'chat-1', contentType: 'agent-session' })
        ]
      }
    })
    expect(targets()).toEqual([])
  })

  it('rejects a runtime page whose host contradicts its owning workspace', () => {
    useAppStore.setState({
      browserPagesByWorkspace: {
        'browser-1': [noticePage({ browserRuntimeEnvironmentId: 'other' })]
      }
    })
    expect(targets()).toEqual([])
  })

  it('supports a remote workspace and keeps its activation host explicit', () => {
    seedBrowserNotice({
      worktreesByRepo: { 'repo-1': [noticeWorktree({ hostId: 'runtime:server' })] },
      browserPagesByWorkspace: {
        'browser-1': [noticePage({ browserRuntimeEnvironmentId: 'server' })]
      }
    })
    expect(targets()[0]?.executionHostId).toBe('runtime:server')
  })

  it('supports folder workspaces without requiring a Git worktree or directory', () => {
    const worktreeId = folderWorkspaceKey('folder-1')
    seedBrowserNotice({
      worktreesByRepo: {},
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'project-1',
          name: 'Folder',
          folderPath: '/project',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0,
          executionHostId: 'local'
        }
      ],
      browserTabsByWorktree: { [worktreeId]: [noticeWorkspace({ worktreeId })] },
      browserPagesByWorkspace: { 'browser-1': [noticePage({ worktreeId })] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          noticeTab({ worktreeId }),
          noticeTab({ id: 'chat-1', contentType: 'agent-session', worktreeId })
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [
          { id: 'group-1', worktreeId, activeTabId: 'chat-1', tabOrder: ['chat-1', 'browser-tab'] }
        ]
      }
    })
    expect(targets()[0]?.page.worktreeId).toBe(worktreeId)
  })
})

describe('opening the site in the default browser', () => {
  it('offers ordinary HTTP(S) sites', () => {
    expect(nativeChatBrowserExternalUrl(noticePage(), 'local')).toBe('https://example.com/docs')
    expect(
      nativeChatBrowserExternalUrl(noticePage({ url: 'http://localhost:3000' }), 'local')
    ).toBe('http://localhost:3000/')
  })

  it.each(['runtime:server', 'ssh:host'] as const)(
    'keeps %s loopback and wildcard hosts on their execution host',
    (executionHostId) => {
      for (const url of [
        'http://localhost:3000/',
        'http://app.localhost:3000/',
        'http://127.0.0.1:3000/',
        'http://127.0.0.9:3000/',
        'http://[::1]:3000/',
        'http://0.0.0.0:3000/',
        'http://[::]:3000/'
      ]) {
        expect(nativeChatBrowserExternalUrl(noticePage({ url }), executionHostId)).toBeNull()
        expect(nativeChatBrowserExternalUrl(noticePage({ url }), 'local')).toBe(url)
      }
      expect(nativeChatBrowserExternalUrl(noticePage(), executionHostId)).toBe(
        'https://example.com/docs'
      )
    }
  )

  it.each([
    'file:///tmp/private.txt',
    'about:blank',
    'javascript:alert(1)',
    'https://user:password@example.com/',
    'https://kagi.com/search?token=private',
    'https://example.com/?access_token=private',
    'https://example.com/#session_id=private'
  ])('does not offer credentials or non-web URLs: %s', (url) => {
    expect(nativeChatBrowserExternalUrl(noticePage({ url }), 'local')).toBeNull()
  })
})
