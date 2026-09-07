import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'

describe('buildMobileSessionTabSnapshots', () => {
  it('does not publish state for a removed folder workspace', () => {
    const staleFolderKey = 'folder:removed-folder'
    const state = makeState({
      folderWorkspaces: [],
      tabsByWorktree: {
        [staleFolderKey]: [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })

    expect(buildMobileSessionTabSnapshots(state)).toEqual([])
  })

  it('publishes state for a live folder workspace', () => {
    const folderWorkspaceId = 'live-folder'
    const folderKey = `folder:${folderWorkspaceId}`
    const state = makeState({
      folderWorkspaces: [{ id: folderWorkspaceId } as AppState['folderWorkspaces'][number]],
      tabsByWorktree: {
        [folderKey]: [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })

    expect(buildMobileSessionTabSnapshots(state)).toEqual([
      expect.objectContaining({ worktree: folderKey })
    ])
  })

  it('evicts a removed folder workspace from the snapshot cache', () => {
    const folderWorkspaceId = 'cache-eviction-folder'
    const folderKey = `folder:${folderWorkspaceId}`
    const liveState = makeState({
      folderWorkspaces: [{ id: folderWorkspaceId } as AppState['folderWorkspaces'][number]],
      tabsByWorktree: {
        [folderKey]: [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const removedState = makeState({
      folderWorkspaces: [],
      tabsByWorktree: liveState.tabsByWorktree
    })

    const initial = buildMobileSessionTabSnapshots(liveState)[0]!
    expect(buildMobileSessionTabSnapshots(removedState)).toEqual([])
    const restored = buildMobileSessionTabSnapshots(liveState)[0]!

    expect(restored.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
  })

  it('publishes a new instance identity when unchanged content is recreated', () => {
    const worktree = {
      id: 'wt-1',
      instanceId: 'old-instance',
      repoId: 'repo-1'
    }
    const base = makeState({
      worktreesByRepo: { 'repo-1': [worktree] } as unknown as AppState['worktreesByRepo'],
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const initial = buildMobileSessionTabSnapshots(base)[0]!
    const recreated = {
      ...base,
      worktreesByRepo: {
        'repo-1': [{ ...worktree, instanceId: 'new-instance' }]
      } as unknown as AppState['worktreesByRepo']
    }

    const next = buildMobileSessionTabSnapshots(recreated)[0]!

    expect(initial.worktreeInstanceId).toBe('old-instance')
    expect(next.worktreeInstanceId).toBe('new-instance')
    expect(next.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
  })

  it('publishes a cross-host id collision without an instance identity', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-duplicate', repoId: 'repo-1', hostId: 'local', instanceId: 'local-instance' },
          {
            id: 'wt-duplicate',
            repoId: 'repo-1',
            hostId: 'ssh:ssh-1',
            instanceId: 'ssh-instance'
          }
        ]
      } as unknown as AppState['worktreesByRepo'],
      tabsByWorktree: {
        'wt-duplicate': [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })

    const snapshots = buildMobileSessionTabSnapshots(state)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.worktree).toBe('wt-duplicate')
    expect(snapshots[0]?.worktreeInstanceId).toBeUndefined()
  })

  it('publishes browser and editor color + pin state from unified tabs', () => {
    const fileId = '/repo/README.md'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'browser-tab-1',
            tabOrder: ['browser-tab-1', 'editor-tab-1'],
            recentTabIds: ['browser-tab-1']
          }
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-tab-1',
            entityId: 'browser-workspace-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'browser',
            label: 'Browser',
            customLabel: null,
            color: '#3b82f6',
            sortOrder: 0,
            createdAt: 1,
            isPreview: false,
            isPinned: false
          },
          {
            id: 'editor-tab-1',
            entityId: fileId,
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'editor',
            label: 'README.md',
            customLabel: null,
            color: '#16a34a',
            sortOrder: 1,
            createdAt: 2,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-workspace-1',
            worktreeId: 'wt-1',
            activePageId: 'browser-page-1',
            pageIds: ['browser-page-1'],
            url: 'https://example.com/',
            title: 'Example Domain',
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
        'browser-workspace-1': [
          {
            id: 'browser-page-1',
            workspaceId: 'browser-workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com/',
            title: 'Example Domain',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'browser',
          id: 'browser-tab-1',
          color: '#3b82f6',
          isPinned: false
        }),
        expect.objectContaining({
          type: 'markdown',
          id: 'editor-tab-1',
          color: '#16a34a',
          isPinned: false
        })
      ])
    )
  })
})
