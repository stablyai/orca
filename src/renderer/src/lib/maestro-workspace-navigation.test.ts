import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { openExactMaestroWorkspace } from './maestro-workspace-navigation'

function navigationState(overrides: Partial<AppState> = {}) {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: 'gray',
        addedAt: 1,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      repo: [
        {
          id: 'repo::same',
          repoId: 'repo',
          hostId: 'local',
          displayName: 'Same',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          path: '/repo',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
      ]
    },
    unifiedTabsByWorktree: {},
    setActiveWorktree: vi.fn(() => true),
    setActiveFolderWorkspace: vi.fn(),
    setSidebarOpen: vi.fn(),
    createUnifiedTab: vi.fn(),
    activateTab: vi.fn(),
    ...overrides
  } as Pick<
    AppState,
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'repos'
    | 'worktreesByRepo'
    | 'unifiedTabsByWorktree'
    | 'setActiveWorktree'
    | 'setActiveFolderWorkspace'
    | 'setSidebarOpen'
    | 'createUnifiedTab'
    | 'activateTab'
  >
}

describe('Maestro workspace navigation', () => {
  it('activates the exact workspace and creates only a Maestro tab', () => {
    const state = navigationState()

    expect(
      openExactMaestroWorkspace(state, {
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::same'
      })
    ).toBe(true)
    expect(state.setActiveWorktree).toHaveBeenCalledWith('repo::same', 'local')
    expect(state.createUnifiedTab).toHaveBeenCalledWith(
      'repo::same',
      'maestro',
      expect.objectContaining({
        maestroExecutionHostId: 'local',
        maestroWorkspaceKey: 'worktree:repo::same'
      })
    )
  })

  it('focuses the exact existing Maestro tab', () => {
    const state = navigationState({
      unifiedTabsByWorktree: {
        'repo::same': [
          {
            id: 'maestro-local',
            entityId: 'maestro-local',
            groupId: 'group',
            worktreeId: 'repo::same',
            contentType: 'maestro',
            label: 'Maestro',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            maestroExecutionHostId: 'local',
            maestroWorkspaceKey: 'worktree:repo::same'
          }
        ]
      }
    })

    expect(
      openExactMaestroWorkspace(state, {
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::same'
      })
    ).toBe(true)
    expect(state.activateTab).toHaveBeenCalledWith('maestro-local', { worktreeId: 'repo::same' })
    expect(state.createUnifiedTab).not.toHaveBeenCalled()
  })

  it('rejects a colliding host and archived workspace before activation', () => {
    const remote = navigationState()
    const archived = navigationState({
      worktreesByRepo: {
        repo: [{ ...navigationState().worktreesByRepo.repo[0], isArchived: true }]
      }
    })

    expect(
      openExactMaestroWorkspace(remote, {
        executionHostId: 'ssh:build',
        workspaceKey: 'worktree:repo::same'
      })
    ).toBe(false)
    expect(
      openExactMaestroWorkspace(archived, {
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::same'
      })
    ).toBe(false)
    expect(remote.setActiveWorktree).not.toHaveBeenCalled()
    expect(archived.setActiveWorktree).not.toHaveBeenCalled()
  })
})
