import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getConnectionId,
  getConnectionIdForFile,
  getConnectionIdFromState,
  isWorktreeConnectionResolved
} from './connection-context'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
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

  it('resolves SSH targets for repo-less folder workspaces from persisted scope provenance', () => {
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
        }
      ],
      repos: [],
      worktreesByRepo: {}
    })

    expect(getConnectionId(folderWorkspaceKey('folder-workspace-1'))).toBe('ssh-1')
  })

  it('returns undefined when persisted folder workspace provenance conflicts with child repos', () => {
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
        }
      ],
      repos: [
        makeRepo({
          id: 'repo-ssh',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-2'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId(folderWorkspaceKey('folder-workspace-1'))).toBeUndefined()
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

  it('resolves folder workspace combined diff sections by child repo path', () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
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

    expect(getConnectionIdForFile(workspaceKey, '/home/neil/platform')).toBeUndefined()
    expect(getConnectionIdForFile(workspaceKey, '/home/neil/platform/api/src/index.ts')).toBe(
      'ssh-1'
    )
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

  it('reports a worktree owner as unresolved until its backing repo hydrates (#6648)', () => {
    useAppStore.setState({ repos: [], worktreesByRepo: {} })
    // SSH repo not yet in the store -> owner unknown, must not read locally.
    expect(isWorktreeConnectionResolved('repo-ssh::/home/neil/repo')).toBe(false)

    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-ssh', connectionId: 'ssh-1' })],
      worktreesByRepo: {}
    })
    expect(isWorktreeConnectionResolved('repo-ssh::/home/neil/repo')).toBe(true)
  })

  it('treats null worktrees and folder workspaces as resolved owners', () => {
    useAppStore.setState({ repos: [], worktreesByRepo: {} })
    expect(isWorktreeConnectionResolved(null)).toBe(true)
    // Folder workspaces resolve per-file via getConnectionIdForFile.
    expect(isWorktreeConnectionResolved(folderWorkspaceKey('folder-workspace-1'))).toBe(true)
  })

  it('treats the floating workspace as a resolved local owner (#6831)', () => {
    useAppStore.setState({ repos: [], worktreesByRepo: {} })

    expect(getConnectionId(FLOATING_TERMINAL_WORKTREE_ID)).toBeNull()
    expect(getConnectionIdForFile(FLOATING_TERMINAL_WORKTREE_ID, '/tmp/orca/note.md')).toBeNull()
    expect(isWorktreeConnectionResolved(FLOATING_TERMINAL_WORKTREE_ID)).toBe(true)
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

  it('resolves a folder workspace connectionId from a passed-in state without reading the global store', () => {
    // Why: the Quick Open hook subscribes to store slices and must resolve from
    // the snapshot it receives, not by re-reading useAppStore.getState().
    const getStateSpy = vi.spyOn(useAppStore, 'getState')
    const state: ConnectionContextState = {
      folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
      projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
      repos: [],
      worktreesByRepo: {}
    }

    expect(getConnectionIdFromState(state, folderWorkspaceKey('folder-workspace-1'))).toBe('ssh-1')
    expect(getStateSpy).not.toHaveBeenCalled()
  })

  it('resolves SSH repo provenance for non-folder worktrees from the passed-in state', () => {
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [makeRepo({ id: 'repo-ssh', connectionId: 'ssh-2' })],
      worktreesByRepo: {}
    }

    expect(getConnectionIdFromState(state, 'repo-ssh::/home/neil/repo-feature')).toBe('ssh-2')
  })

  it('indexes immutable worktree and repo snapshots once across repeated selector calls', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    const targetWorktreeId = 'worktree-99-99'
    const targetRepoId = 'repo-99'
    const worktreesByRepo: AppState['worktreesByRepo'] = {}
    const repos: Repo[] = []

    for (let repoIndex = 0; repoIndex < 100; repoIndex += 1) {
      const repoId = `repo-${repoIndex}`
      const repo = makeRepo({
        id: repoId,
        ...(repoId === targetRepoId ? { connectionId: 'ssh-target' } : {})
      })
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => {
          repoIdReads += 1
          return repoId
        }
      })
      repos.push(repo)
      worktreesByRepo[repoId] = Array.from({ length: 100 }, (_, worktreeIndex) => {
        const worktreeId = `worktree-${repoIndex}-${worktreeIndex}`
        const worktree = { repoId } as Worktree
        Object.defineProperty(worktree, 'id', {
          enumerable: true,
          get: () => {
            worktreeIdReads += 1
            return worktreeId
          }
        })
        return worktree
      })
    }
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos,
      worktreesByRepo
    }

    for (let lookup = 0; lookup < 200; lookup += 1) {
      expect(getConnectionIdFromState(state, targetWorktreeId)).toBe('ssh-target')
    }

    expect(worktreeIdReads).toBe(10_000)
    expect(repoIdReads).toBe(100)
  })

  it('returns null for a null worktreeId', () => {
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    }

    expect(getConnectionIdFromState(state, null)).toBeNull()
  })
})
