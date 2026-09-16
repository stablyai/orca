// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getNotificationWorkspaceLabels } from './terminal-notification-state'

function stateWithWorkspace() {
  return {
    ...useAppStore.getInitialState(),
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', displayName: 'Feature' })] },
    repos: [
      {
        id: 'repo',
        displayName: 'Orca',
        path: '/orca',
        connectionId: null,
        badgeColor: 'blue',
        addedAt: 0
      }
    ]
  }
}

describe('notification workspace labels', () => {
  it('includes the only project without reading agent inventories', () => {
    const state = stateWithWorkspace()
    Object.defineProperty(state, 'agentStatusByPaneKey', {
      get() {
        throw new Error('agent scan')
      }
    })
    Object.defineProperty(state, 'retainedAgentsByPaneKey', {
      get() {
        throw new Error('retained scan')
      }
    })
    expect(getNotificationWorkspaceLabels(state, 'wt')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Feature'
    })
    expect(getNotificationWorkspaceLabels(state, 'worktree:wt')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Feature'
    })
  })

  it('keeps labels for remote Git workspaces', () => {
    const state = stateWithWorkspace()
    state.worktreesByRepo.repo = [
      makeWorktree({
        id: 'remote',
        repoId: 'repo',
        hostId: 'ssh:server',
        displayName: 'Remote feature'
      })
    ]
    expect(getNotificationWorkspaceLabels(state, 'remote')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Remote feature'
    })
  })

  it.each([undefined, 'ssh:server'] as const)(
    'resolves folder and project names on host %s',
    (executionHostId) => {
      const state = stateWithWorkspace()
      state.folderWorkspaces = [
        makeFolderWorkspace({
          id: 'folder-id',
          projectGroupId: 'group',
          name: 'Website',
          executionHostId
        })
      ]
      state.projectGroups = [
        {
          id: 'group',
          name: 'Personal',
          executionHostId,
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ]
      expect(getNotificationWorkspaceLabels(state, 'folder:folder-id')).toEqual({
        repoLabel: 'Personal',
        worktreeLabel: 'Website'
      })
      state.projectGroups = []
      expect(getNotificationWorkspaceLabels(state, 'folder:folder-id')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'Website'
      })
    }
  )

  it.each([false, true])(
    'qualifies project groups by the folder host (legacy SSH: %s)',
    (legacy) => {
      const state = stateWithWorkspace()
      state.folderWorkspaces = [
        makeFolderWorkspace({
          id: 'remote-folder',
          name: 'Remote folder',
          projectGroupId: 'shared',
          ...(legacy ? { connectionId: 'server' } : { executionHostId: 'ssh:server' as const })
        })
      ]
      state.projectGroups = (['local', 'ssh:server'] as const).map((executionHostId) => ({
        id: 'shared',
        name: executionHostId === 'local' ? 'Local group' : 'Remote group',
        executionHostId,
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual' as const,
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }))
      expect(getNotificationWorkspaceLabels(state, 'folder:remote-folder')).toEqual({
        repoLabel: 'Remote group',
        worktreeLabel: 'Remote folder'
      })
    }
  )

  it('does not pick an arbitrary folder when hosts have conflicting records', () => {
    const state = stateWithWorkspace()
    state.folderWorkspaces = (['ssh:a', 'ssh:b'] as const).map((executionHostId) =>
      makeFolderWorkspace({ id: 'duplicate', name: executionHostId, executionHostId })
    )
    expect(getNotificationWorkspaceLabels(state, 'folder:duplicate', 'Terminal')).toEqual({
      repoLabel: undefined,
      worktreeLabel: 'Terminal'
    })
  })

  it.each(['folder:missing', 'missing-worktree', FLOATING_TERMINAL_WORKTREE_ID])(
    'uses readable fallbacks for %s',
    (id) => {
      const state = stateWithWorkspace()
      expect(getNotificationWorkspaceLabels(state, id, 'My terminal')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'My terminal'
      })
      expect(getNotificationWorkspaceLabels(state, id, '  ')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'workspace'
      })
    }
  )
})
