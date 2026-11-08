import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getConnectionId,
  getConnectionIdForFile,
  getConnectionIdFromState
} from './connection-context'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { createConnectionIdForFileSelector } from './connection-owner-resolution'

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

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/srv/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('getConnectionId', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('returns undefined for folder workspaces with mixed local and SSH repos', () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'folder-workspace-1',
          projectGroupId: 'group-1',
          name: 'Platform workspace',
          folderPath: '/home/neil/platform',
          linkedTask: null,
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
          id: 'repo-local',
          path: '/home/neil/platform/web',
          projectGroupId: 'group-1'
        }),
        makeRepo({
          id: 'repo-ssh',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId(workspaceKey)).toBeUndefined()
    expect(getConnectionIdForFile(workspaceKey, '/home/neil/platform/api/src/index.ts')).toBe(
      'ssh-1'
    )
    expect(getConnectionIdForFile(workspaceKey, '/home/neil/platform/web/src/index.ts')).toBeNull()
    expect(getConnectionIdForFile(workspaceKey, '/home/neil/platform/README.md')).toBeUndefined()
  })

  it('keeps normalized same-path folder repo ambiguity when resolving files', () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'folder-workspace-1',
          projectGroupId: 'group-1',
          name: 'Platform workspace',
          folderPath: '/home/neil/platform',
          linkedTask: null,
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
          id: 'repo-ssh-1',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        }),
        makeRepo({
          id: 'repo-ssh-2',
          path: '/home/neil/platform/api/',
          projectGroupId: 'group-1',
          connectionId: 'ssh-2'
        })
      ],
      worktreesByRepo: {}
    })

    expect(
      getConnectionIdForFile(workspaceKey, '/home/neil/platform/api/src/index.ts')
    ).toBeUndefined()
  })

  it('keeps explicit folder workspace provenance isolated from unrelated same-path SSH repos', () => {
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'folder-workspace-1',
          projectGroupId: 'group-1',
          name: 'Platform workspace',
          folderPath: '/home/neil/platform',
          connectionId: 'ssh-1',
          linkedTask: null,
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
          connectionId: 'ssh-1',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'group-2',
          name: 'Platform copy',
          parentPath: '/home/neil/platform',
          connectionId: 'ssh-2',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 1,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      repos: [
        makeRepo({
          id: 'repo-ssh-1',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        }),
        makeRepo({
          id: 'repo-ssh-2',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-2',
          connectionId: 'ssh-2'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId(folderWorkspaceKey('folder-workspace-1'))).toBe('ssh-1')
  })
})

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath: '/home/neil/platform',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/home/neil/platform',
    connectionId: null,
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

type ConnectionContextState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

describe('getConnectionIdFromState', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses to resolve a connection when duplicate repo rows disagree about the owning host', () => {
    // Same-ID repo rows with conflicting owners must not lend a client SSH connection to a runtime (#17799).
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        makeRepo({ id: 'repo-dup', executionHostId: 'runtime:env-a' }),
        makeRepo({ id: 'repo-dup', connectionId: 'ssh-client' })
      ],
      worktreesByRepo: {}
    }

    expect(getConnectionIdFromState(state, 'repo-dup::/home/neil/repo-feature')).toBeUndefined()
  })

  it('keeps a runtime host nested SSH target, which decides local readability', () => {
    // Retain nested SSH ownership with its publishing runtime; null would authorize a local transcript read on the wrong machine.
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        makeRepo({
          id: 'repo-runtime',
          connectionId: 'ssh-nested',
          executionHostId: 'runtime:env-a'
        })
      ],
      worktreesByRepo: {
        'repo-runtime': [
          makeWorktree({
            id: 'repo-runtime::/srv/repo',
            repoId: 'repo-runtime',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          })
        ]
      }
    }

    expect(getConnectionIdFromState(state, 'repo-runtime::/srv/repo')).toBe('ssh-nested')
  })

  it('invalidates folder connection inference for each catalog slice and preserves tri-state answers', () => {
    const key = folderWorkspaceKey('folder-workspace-1')
    const state: ConnectionContextState = {
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [makeRepo({ id: 'repo-1', projectGroupId: 'group-1', connectionId: 'ssh-1' })],
      worktreesByRepo: {}
    }
    expect(getConnectionIdFromState(state, key)).toBe('ssh-1')
    const local = {
      ...state,
      repos: [makeRepo({ id: 'repo-1', projectGroupId: 'group-1' })]
    }
    expect(getConnectionIdFromState(local, key)).toBeNull()
    const contested = {
      ...local,
      projectGroups: [makeProjectGroup()],
      repos: [
        ...local.repos,
        makeRepo({ id: 'repo-2', projectGroupId: 'group-1', connectionId: 'ssh-2' })
      ]
    }
    expect(getConnectionIdFromState(contested, key)).toBeUndefined()
    expect(getConnectionIdFromState(contested, key)).toBeUndefined()
    const pinned = {
      ...contested,
      folderWorkspaces: [
        makeFolderWorkspace({ executionHostId: 'runtime:host-a', connectionId: 'nested-ssh' })
      ]
    }
    expect(getConnectionIdFromState(pinned, key)).toBe('nested-ssh')
    expect(getConnectionIdFromState({ ...pinned, folderWorkspaces: [] }, key)).toBeUndefined()
    // Retained snapshots remain independent when React reads them between current publications.
    expect(getConnectionIdFromState(state, key)).toBe('ssh-1')
    expect(getConnectionIdFromState(local, key)).toBeNull()
  })

  it('recomputes a retained file-owner selector when ownership slices hydrate', () => {
    const selector = createConnectionIdForFileSelector(
      'repo-ssh::/home/neil/repo-feature',
      '/home/neil/repo-feature/README.md'
    )
    const unresolved: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    }
    expect(selector(unresolved)).toBeUndefined()

    const hydrated: ConnectionContextState = {
      ...unresolved,
      repos: [makeRepo({ id: 'repo-ssh', connectionId: 'ssh-hydrated' })]
    }
    expect(selector(hydrated)).toBe('ssh-hydrated')
  })

  it('never hands a worktree the SSH connection of a different host', () => {
    // Host lookup misses must not fall back by repo ID to another SSH machine’s connection (#11163).
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [makeRepo({ id: 'repo-shared', connectionId: 'openclaw' })],
      worktreesByRepo: {
        'repo-shared': [
          makeWorktree({
            id: 'repo-shared::/srv/repo',
            repoId: 'repo-shared',
            hostId: 'ssh:m4air'
          })
        ]
      }
    }

    expect(getConnectionIdFromState(state, 'repo-shared::/srv/repo')).toBe('m4air')
  })
})
