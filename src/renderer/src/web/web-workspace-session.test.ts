import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sanitizeWebRuntimeWorkspaceSession } from './web-workspace-session'

describe('sanitizeWebRuntimeWorkspaceSession', () => {
  it('drops persisted remote panes while preserving harmless web-local session fields', () => {
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: 'repo-1::/worktree',
      activeTabId: 'stale-terminal-tab',
      tabsByWorktree: {
        'repo-1::/worktree': [
          {
            id: 'stale-terminal-tab',
            ptyId: 'remote:web-old@@term-old',
            worktreeId: 'repo-1::/worktree',
            title: 'Old terminal',
            defaultTitle: 'Old terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'stale-terminal-tab': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'remote:web-old@@term-old' }
        }
      },
      activeWorktreeIdsOnShutdown: ['repo-1::/worktree'],
      openFilesByWorktree: {
        'repo-1::/worktree': [
          {
            filePath: '/worktree/README.md',
            relativePath: 'README.md',
            worktreeId: 'repo-1::/worktree',
            language: 'markdown',
            runtimeEnvironmentId: 'web-old'
          }
        ]
      },
      activeFileIdByWorktree: { 'repo-1::/worktree': '/worktree/README.md' },
      browserTabsByWorktree: {
        'repo-1::/worktree': [
          {
            id: 'stale-browser-workspace',
            worktreeId: 'repo-1::/worktree',
            activePageId: 'stale-page',
            pageIds: ['stale-page'],
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'stale-browser-workspace': [
          {
            id: 'stale-page',
            workspaceId: 'stale-browser-workspace',
            worktreeId: 'repo-1::/worktree',
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { 'repo-1::/worktree': 'stale-browser-workspace' },
      activeTabTypeByWorktree: { 'repo-1::/worktree': 'browser' },
      browserUrlHistory: [
        {
          url: 'https://example.com/',
          normalizedUrl: 'https://example.com/',
          title: 'Example',
          lastVisitedAt: 1,
          visitCount: 1
        }
      ],
      activeTabIdByWorktree: { 'repo-1::/worktree': 'stale-terminal-tab' },
      unifiedTabs: {
        'repo-1::/worktree': [
          {
            id: 'stale-terminal-tab',
            entityId: 'stale-terminal-tab',
            groupId: 'group-1',
            worktreeId: 'repo-1::/worktree',
            contentType: 'terminal',
            label: 'Old terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      tabGroups: {
        'repo-1::/worktree': [
          {
            id: 'group-1',
            worktreeId: 'repo-1::/worktree',
            activeTabId: 'stale-terminal-tab',
            tabOrder: ['stale-terminal-tab'],
            recentTabIds: ['stale-terminal-tab']
          }
        ]
      },
      tabGroupLayouts: { 'repo-1::/worktree': { type: 'leaf', groupId: 'group-1' } },
      activeGroupIdByWorktree: { 'repo-1::/worktree': 'group-1' },
      activeConnectionIdsAtShutdown: ['ssh-1'],
      remoteSessionIdsByTabId: { 'stale-terminal-tab': 'remote-pty-1' },
      lastVisitedAtByWorktreeId: { 'repo-1::/worktree': 2 }
    }

    const sanitized = sanitizeWebRuntimeWorkspaceSession(session)

    expect(sanitized).toMatchObject({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'repo-1::/worktree',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      activeBrowserTabIdByWorktree: {},
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      browserUrlHistory: session.browserUrlHistory,
      lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId
    })
    expect(sanitized.remoteSessionIdsByTabId).toBeUndefined()
    expect(sanitized.activeWorktreeIdsOnShutdown).toBeUndefined()
    expect(sanitized.unifiedTabs).toBeUndefined()
    expect(sanitized.tabGroups).toBeUndefined()
  })

  it('never persists projected terminal scrollback (incl. an incognito terminal) to browser storage', () => {
    // Regression guard: the paired-web/mobile client receives projected terminal buffers for live
    // display, but must never write them to its own localStorage. This proves an incognito
    // terminal's scrollback cannot land in the mobile client's store.
    const session = {
      activeRepoId: 'repo-1',
      activeWorktreeId: 'repo-1::/worktree',
      activeTabId: 'incognito-tab',
      tabsByWorktree: {
        'repo-1::/worktree': [
          {
            id: 'incognito-tab',
            ptyId: 'remote:web@@term-incognito',
            worktreeId: 'repo-1::/worktree',
            title: 'pi',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            incognito: true
          }
        ]
      },
      terminalLayoutsByTabId: {
        'incognito-tab': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          buffersByLeafId: { 'leaf-1': 'SECRET-incognito-scrollback' },
          scrollbackRefsByLeafId: { 'leaf-1': 'v1-secret' },
          ptyIdsByLeafId: { 'leaf-1': 'remote:web@@term-incognito' }
        }
      },
      localOnlyScrollbackByTabId: { 'incognito-tab': { 'leaf-1': 'SECRET-local-only' } },
      lastVisitedAtByWorktreeId: { 'repo-1::/worktree': 2 }
    } as unknown as WorkspaceSessionState

    const sanitized = sanitizeWebRuntimeWorkspaceSession(session)
    const serialized = JSON.stringify(sanitized)

    expect(sanitized.terminalLayoutsByTabId).toEqual({})
    expect(sanitized.localOnlyScrollbackByTabId).toBeUndefined()
    expect(serialized).not.toContain('SECRET-incognito-scrollback')
    expect(serialized).not.toContain('SECRET-local-only')
    expect(serialized).not.toContain('v1-secret')
  })
})
