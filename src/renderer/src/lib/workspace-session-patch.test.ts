import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-2', title: 'editor', ptyId: null, worktreeId: 'wt-2' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['pty-1'],
      'tab-2': []
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1', 'wt-2': 'tab-2' },
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    openFiles: [
      {
        id: '/tmp/demo.ts',
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
        id: '/tmp/demo.diff',
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
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as WorkspaceSessionSnapshot
}

function createRepo(id: string, connectionId: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#fff',
    addedAt: 1,
    connectionId
  }
}

describe('buildWorkspaceSessionPatch', () => {
  it('returns only the direct key for active tab changes', () => {
    const patch = buildWorkspaceSessionPatch(createSnapshot({ activeTabId: 'tab-2' }), [
      'activeTabId'
    ])

    expect(patch).toEqual({ activeTabId: 'tab-2' })
  })

  it('derives only editor session keys for open file changes', () => {
    const patch = buildWorkspaceSessionPatch(createSnapshot(), ['openFiles'])

    expect(Object.keys(patch).sort()).toEqual(
      [
        'activeFileIdByWorktree',
        'activeTabTypeByWorktree',
        'markdownFrontmatterVisible',
        'openFilesByWorktree'
      ].sort()
    )
    expect(patch.openFilesByWorktree).toEqual({
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
  })

  it('derives editor session keys when only editor drafts change', () => {
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({
        openFiles: [
          {
            id: '/tmp/demo.ts',
            filePath: '/tmp/demo.ts',
            relativePath: 'demo.ts',
            worktreeId: 'wt-1',
            language: 'typescript',
            mode: 'edit',
            isDirty: true
          } as never
        ],
        editorDrafts: { '/tmp/demo.ts': 'edited' }
      }),
      ['editorDrafts']
    )

    expect(Object.keys(patch).sort()).toEqual(
      [
        'activeFileIdByWorktree',
        'activeTabTypeByWorktree',
        'markdownFrontmatterVisible',
        'openFilesByWorktree'
      ].sort()
    )
    expect(patch.openFilesByWorktree?.['wt-1'][0]).toEqual(
      expect.objectContaining({
        filePath: '/tmp/demo.ts',
        dirtyDraftContent: 'edited'
      })
    )
  })

  it('derives editor session keys when markdown front-matter visibility changes', () => {
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({
        markdownFrontmatterVisible: {
          '/tmp/demo.ts': true,
          '/tmp/demo.diff': true
        }
      }),
      ['markdownFrontmatterVisible']
    )

    expect(Object.keys(patch).sort()).toEqual(
      [
        'activeFileIdByWorktree',
        'activeTabTypeByWorktree',
        'markdownFrontmatterVisible',
        'openFilesByWorktree'
      ].sort()
    )
    expect(patch.markdownFrontmatterVisible).toEqual({ '/tmp/demo.ts': true })
  })

  it('sanitizes terminal tabs and prunes local buffers when tab topology changes', () => {
    const localWorktreeId = 'repo-1::/local/worktree'
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({
        tabsByWorktree: {
          [localWorktreeId]: [
            {
              id: 'tab-local',
              title: 'shell',
              ptyId: 'pty-1',
              worktreeId: localWorktreeId,
              pendingActivationSpawn: true
            } as never
          ]
        },
        ptyIdsByTabId: {
          'tab-local': ['pty-1']
        },
        terminalLayoutsByTabId: {
          'tab-local': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'serialized-local-scrollback' },
            scrollbackRefsByLeafId: { 'pane:1': 'v1-local' },
            ptyIdsByLeafId: { 'pane:1': 'pty-1' }
          }
        },
        repos: [createRepo('repo-1', null)]
      }),
      ['tabsByWorktree']
    )

    expect(Object.keys(patch).sort()).toEqual(
      [
        'activeWorktreeIdsOnShutdown',
        'remoteSessionIdsByTabId',
        'tabsByWorktree',
        'terminalLayoutsByTabId'
      ].sort()
    )
    expect('pendingActivationSpawn' in patch.tabsByWorktree![localWorktreeId][0]).toBe(false)
    expect(patch.terminalLayoutsByTabId?.['tab-local'].buffersByLeafId).toBeUndefined()
    expect(patch.terminalLayoutsByTabId?.['tab-local'].scrollbackRefsByLeafId).toBeUndefined()
  })

  it('keeps optional clearing keys in patches', () => {
    const patch = buildWorkspaceSessionPatch(createSnapshot({ sshConnectionStates: new Map() }), [
      'sshConnectionStates'
    ])

    expect(Object.hasOwn(patch, 'activeConnectionIdsAtShutdown')).toBe(true)
    expect(patch.activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it('persists default terminal tab idempotency marker changes', () => {
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({ defaultTerminalTabsAppliedByWorktreeId: { 'wt-1': true } }),
      ['defaultTerminalTabsAppliedByWorktreeId']
    )

    expect(patch).toEqual({
      defaultTerminalTabsAppliedByWorktreeId: { 'wt-1': true }
    })
  })

  it('keeps default terminal tab marker clearing keys in patches', () => {
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({ defaultTerminalTabsAppliedByWorktreeId: {} }),
      ['defaultTerminalTabsAppliedByWorktreeId']
    )

    expect(Object.hasOwn(patch, 'defaultTerminalTabsAppliedByWorktreeId')).toBe(true)
    expect(patch.defaultTerminalTabsAppliedByWorktreeId).toBeUndefined()
  })

  it('keeps sleeping agent session clearing keys in patches', () => {
    const patch = buildWorkspaceSessionPatch(
      createSnapshot({ sleepingAgentSessionsByPaneKey: {} }),
      ['sleepingAgentSessionsByPaneKey']
    )

    expect(Object.hasOwn(patch, 'sleepingAgentSessionsByPaneKey')).toBe(true)
    expect(patch.sleepingAgentSessionsByPaneKey).toBeUndefined()
  })
})
