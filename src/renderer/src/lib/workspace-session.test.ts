import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceSessionPayload,
  SESSION_RELEVANT_FIELDS,
  type WorkspaceSessionSnapshot
} from './workspace-session'
import type { AppState } from '../store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

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
    browserUrlHistory: [],
    ...overrides
  } as AppState
}

function createRepo(id: string, connectionId: string | null): AppState['repos'][number] {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#fff',
    addedAt: 1,
    connectionId
  }
}

describe('buildWorkspaceSessionPayload', () => {
  it('preserves activeWorktreeIdsOnShutdown for full replacement writes', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-1'])
  })

  it('persists floating terminal tabs for daemon reattach after restart', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-tab-1',
              title: 'Terminal 1',
              ptyId: 'floating-pty-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID
            } as never
          ]
        },
        terminalLayoutsByTabId: {
          'floating-tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'floating-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'floating-pty-1' }
          }
        },
        activeTabIdByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-tab-1'
        }
      })
    )

    expect(payload.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(payload.activeTabIdByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID]).toBe('floating-tab-1')
    expect(payload.terminalLayoutsByTabId['floating-tab-1'].buffersByLeafId).toBeUndefined()
    expect(payload.terminalLayoutsByTabId['floating-tab-1'].ptyIdsByLeafId).toEqual({
      'pane:1': 'floating-pty-1'
    })
    expect(payload.activeWorktreeIdsOnShutdown).toEqual([FLOATING_TERMINAL_WORKTREE_ID])
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

  it('drops local terminal scrollback buffers from session payloads', () => {
    const localWorktreeId = 'repo-1::/local/worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [localWorktreeId]: [
            {
              id: 'tab-local',
              title: 'shell',
              ptyId: 'pty-1',
              worktreeId: localWorktreeId
            } as never
          ]
        },
        terminalLayoutsByTabId: {
          'tab-local': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'serialized-local-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'pty-1' },
            titlesByLeafId: { 'pane:1': 'build' }
          }
        },
        repos: [createRepo('repo-1', null)]
      })
    )

    expect(payload.terminalLayoutsByTabId['tab-local']).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:1': 'pty-1' },
      titlesByLeafId: { 'pane:1': 'build' }
    })
  })

  it('preserves SSH terminal scrollback buffers because relay teardown has no local history', () => {
    const sshWorktreeId = 'repo-ssh::/remote/worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [sshWorktreeId]: [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: 'relay-pty-1',
              worktreeId: sshWorktreeId
            } as never
          ]
        },
        terminalLayoutsByTabId: {
          'tab-ssh': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'serialized-remote-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'relay-pty-1' }
          }
        },
        repos: [createRepo('repo-ssh', 'conn-1')]
      })
    )

    expect(payload.terminalLayoutsByTabId['tab-ssh'].buffersByLeafId).toEqual({
      'pane:1': 'serialized-remote-scrollback'
    })
  })

  it('uses lastKnownRelayPtyIdByTabId fallback for SSH worktrees with null ptyIds', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' } as never],
          'wt-ssh': [{ id: 'tab-ssh', title: 'remote', ptyId: null, worktreeId: 'wt-ssh' } as never]
        },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [createRepo('repo-ssh', 'conn-1')],
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

describe('SESSION_RELEVANT_FIELDS', () => {
  // Why: this list gates the App-level session-write debounce subscriber.
  // If a future field is added to WorkspaceSessionSnapshot but not to the
  // gate, the subscriber would silently stop noticing changes to that field
  // and persist stale data. Listing every key here as a fixture and asserting
  // the gate covers them catches the drift at test time. The compile-time
  // _exhaustive check in workspace-session.ts is the primary line of defense;
  // this test is the runtime backstop.
  const fixture: Record<keyof WorkspaceSessionSnapshot, true> = {
    activeRepoId: true,
    activeWorktreeId: true,
    activeTabId: true,
    tabsByWorktree: true,
    terminalLayoutsByTabId: true,
    activeTabIdByWorktree: true,
    openFiles: true,
    activeFileIdByWorktree: true,
    activeTabTypeByWorktree: true,
    browserTabsByWorktree: true,
    browserPagesByWorkspace: true,
    activeBrowserTabIdByWorktree: true,
    browserUrlHistory: true,
    unifiedTabsByWorktree: true,
    groupsByWorktree: true,
    layoutByWorktree: true,
    activeGroupIdByWorktree: true,
    sshConnectionStates: true,
    repos: true,
    worktreesByRepo: true,
    lastKnownRelayPtyIdByTabId: true,
    lastVisitedAtByWorktreeId: true
  }

  it('contains every key of WorkspaceSessionSnapshot', () => {
    const fixtureKeys = Object.keys(fixture)
    expect(
      fixtureKeys.every((k) => (SESSION_RELEVANT_FIELDS as readonly string[]).includes(k))
    ).toBe(true)
    expect(SESSION_RELEVANT_FIELDS.length).toBe(fixtureKeys.length)
  })

  it('has no duplicate entries', () => {
    expect(new Set(SESSION_RELEVANT_FIELDS).size).toBe(SESSION_RELEVANT_FIELDS.length)
  })
})
