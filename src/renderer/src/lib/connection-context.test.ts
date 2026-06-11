import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import { useAppStore } from '@/store'
import { getConnectionId } from './connection-context'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/home/neil/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('getConnectionId', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('resolves SSH targets from composite worktree IDs before worktree discovery completes', () => {
    useAppStore.setState({
      repos: [
        makeRepo({
          id: 'repo-ssh',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-ssh::/home/neil/repo-feature')).toBe('ssh-1')
  })

  it('returns null for known local repos without a discovered worktree', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-local::/Users/me/repo-feature')).toBeNull()
  })

  it('returns undefined when neither the worktree nor repo is known', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-missing::/tmp/repo-feature')).toBeUndefined()
  })

  it('resolves SSH targets for folder workspaces from repos in the folder scope', () => {
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'folder-workspace-1',
          projectGroupId: 'group-1',
          name: 'Platform workspace',
          folderPath: '/home/neil/platform',
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Platform',
          parentPath: '/home/neil/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      repos: [
        makeRepo({
          id: 'repo-ssh',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId(folderWorkspaceKey('folder-workspace-1'))).toBe('ssh-1')
  })
})
