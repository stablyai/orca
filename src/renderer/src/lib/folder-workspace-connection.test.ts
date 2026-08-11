import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import {
  getFolderWorkspaceCandidateRepos,
  getFolderWorkspaceConnectionId,
  type FolderWorkspaceConnectionState
} from './folder-workspace-connection'

function folder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/workspace',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    parentPath: '/workspace',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function repo(
  id: string,
  connectionId: string | null,
  executionHostId?: Repo['executionHostId']
): Repo {
  return {
    id,
    path: `/workspace/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    projectGroupId: 'group-1',
    connectionId,
    executionHostId
  }
}

function state(overrides: Partial<FolderWorkspaceConnectionState>): FolderWorkspaceConnectionState {
  return { folderWorkspaces: [], projectGroups: [], repos: [], ...overrides }
}

describe('folder workspace connection authority', () => {
  it('keeps an explicit local folder out of its SSH group scope', () => {
    const localRepo = repo('local-repo', null)
    const sshRepo = repo('ssh-repo', 'ssh-1')
    const input = state({
      folderWorkspaces: [folder({ connectionId: null })],
      projectGroups: [group({ connectionId: 'ssh-1' })],
      repos: [localRepo, sshRepo]
    })

    expect(getFolderWorkspaceConnectionId(input, 'folder-1')).toBeNull()
    expect(getFolderWorkspaceCandidateRepos(input, 'folder-1')).toEqual([localRepo])
  })

  it('lets an omitted connection inherit one proven group owner', () => {
    const sshRepo = repo('ssh-repo', 'ssh-1')
    const input = state({
      folderWorkspaces: [folder()],
      projectGroups: [group({ connectionId: 'ssh-1' })],
      repos: [sshRepo]
    })

    expect(getFolderWorkspaceConnectionId(input, 'folder-1')).toBe('ssh-1')
    expect(getFolderWorkspaceCandidateRepos(input, 'folder-1')).toEqual([sshRepo])
  })

  it('fails closed when an omitted connection has conflicting same-ID groups', () => {
    const input = state({
      folderWorkspaces: [folder()],
      projectGroups: [
        group({ connectionId: null, executionHostId: 'local' }),
        group({ connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' })
      ],
      repos: [repo('local-repo', null), repo('ssh-repo', 'ssh-1')]
    })

    expect(getFolderWorkspaceConnectionId(input, 'folder-1')).toBeUndefined()
    expect(getFolderWorkspaceCandidateRepos(input, 'folder-1')).toEqual([])
  })

  it('uses a folder host stamp to isolate a same-ID group catalog', () => {
    const sshOneRepo = repo('ssh-one', 'ssh-1', 'ssh:ssh-1')
    const sshTwoRepo = repo('ssh-two', 'ssh-2', 'ssh:ssh-2')
    const input = state({
      folderWorkspaces: [folder({ executionHostId: 'ssh:ssh-2' })],
      projectGroups: [
        group({ connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }),
        group({ connectionId: 'ssh-2', executionHostId: 'ssh:ssh-2' })
      ],
      repos: [sshOneRepo, sshTwoRepo]
    })

    expect(getFolderWorkspaceConnectionId(input, 'folder-1')).toBe('ssh-2')
    expect(getFolderWorkspaceCandidateRepos(input, 'folder-1')).toEqual([sshTwoRepo])
  })

  it('requires an active host to select colliding folder rows', () => {
    const input = state({
      folderWorkspaces: [
        folder({ connectionId: null, executionHostId: 'local' }),
        folder({ connectionId: null, executionHostId: 'runtime:env-1' })
      ],
      projectGroups: [
        group({ connectionId: null, executionHostId: 'local' }),
        group({ connectionId: null, executionHostId: 'runtime:env-1' })
      ]
    })

    expect(getFolderWorkspaceConnectionId(input, 'folder-1')).toBeUndefined()
    expect(
      getFolderWorkspaceConnectionId(
        {
          ...input,
          activeWorktreeId: 'folder:folder-1',
          activeWorkspaceExecutionHostId: 'runtime:env-1'
        },
        'folder-1'
      )
    ).toBeNull()
  })
})
