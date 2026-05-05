import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPayload } from './workspace-session'
import type { AppState } from '../store'

function createSnapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-2', title: 'editor', ptyId: null, worktreeId: 'wt-2' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1', 'wt-2': 'tab-2' },
    openFiles: [
      {
        filePath: '/tmp/demo.ts',
        relativePath: 'demo.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      },
      {
        filePath: '/tmp/demo.diff',
        relativePath: 'demo.diff',
        worktreeId: 'wt-1',
        language: 'diff',
        mode: 'diff',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      }
    ],
    activeFileIdByWorktree: { 'wt-1': '/tmp/demo.ts' },
    activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' },
    browserTabsByWorktree: {
      'wt-1': [
        {
          id: 'browser-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          errorCode: null,
          errorDescription: null
        }
      ]
    },
    activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
    lastKnownRelayPtyIdByTabId: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    browserPagesByWorkspace: {
      'browser-1': [
        {
          id: 'page-1',
          workspaceId: 'browser-1',
          worktreeId: 'wt-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: Date.now()
        }
      ]
    },
    ...overrides
  } as AppState
}

describe('buildWorkspaceSessionPayload', () => {
  it('preserves activeWorktreeIdsOnShutdown for full replacement writes', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-1'])
  })

  it('persists only edit-mode files and resets browser loading state', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.openFilesByWorktree).toEqual({
      'wt-1': [
        {
          filePath: '/tmp/demo.ts',
          relativePath: 'demo.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isPreview: undefined
        }
      ]
    })
    expect(payload.browserTabsByWorktree?.['wt-1'][0].loading).toBe(false)
  })

  it('uses lastKnownRelayPtyIdByTabId fallback for SSH worktrees with null ptyIds', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' } as never],
          'wt-ssh': [{ id: 'tab-ssh', title: 'remote', ptyId: null, worktreeId: 'wt-ssh' } as never]
        },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [{ id: 'repo-ssh', connectionId: 'conn-1' } as never],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        },
        sshConnectionStates: new Map([
          ['conn-1', { status: 'connected', targetId: 'conn-1', error: null, reconnectAttempt: 0 }]
        ]) as never
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toContain('wt-ssh')
    expect(payload.remoteSessionIdsByTabId).toEqual({ 'tab-ssh': 'relay-sess-42' })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('drops transient active editor markers that do not point at restored edit files', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        activeFileIdByWorktree: { 'wt-1': '/tmp/demo.diff' },
        activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' }
      })
    )

    expect(payload.activeFileIdByWorktree).toEqual({})
    expect(payload.activeTabTypeByWorktree).toEqual({ 'wt-2': 'terminal' })
  })
})
