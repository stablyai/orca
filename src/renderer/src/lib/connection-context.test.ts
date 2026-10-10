import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
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

  it('refuses to resolve a connection when duplicate repo rows disagree about the owning host', () => {
    // Why (#17799): a repo id carried by two rows — one runtime-owned, one holding a
    // client-owned SSH connection — must not hand the client's connection to the runtime.
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

  it('still resolves duplicate repo rows that agree about the owning host', () => {
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        makeRepo({ id: 'repo-dup', connectionId: 'ssh-same' }),
        makeRepo({ id: 'repo-dup', connectionId: 'ssh-same', path: '/home/neil/other' })
      ],
      worktreesByRepo: {}
    }

    expect(getConnectionIdFromState(state, 'repo-dup::/home/neil/repo-feature')).toBe('ssh-same')
  })

  it('never hands a worktree the SSH connection of a different host', () => {
    // Why (#11163): two SSH hosts, one shared repo id. The worktree names `ssh:m4air`; the only
    // indexed row belongs to `openclaw`. An id-only fallback after the host lookup misses answers
    // with the wrong host's connection — "Reconnect openclaw" on an m4air pane, and file reads
    // routed to a machine that never held the path.
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

  it('never hands a runtime-hosted worktree a client-owned SSH connection', () => {
    // The row is on `ssh:openclaw`, not on the runtime host, so it says nothing about this
    // worktree. This is the cross-host case, not the nested-SSH one below.
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [makeRepo({ id: 'repo-shared', connectionId: 'openclaw' })],
      worktreesByRepo: {
        'repo-shared': [
          makeWorktree({
            id: 'repo-shared::/srv/repo',
            repoId: 'repo-shared',
            hostId: 'runtime:awin'
          })
        ]
      }
    }

    expect(getConnectionIdFromState(state, 'repo-shared::/srv/repo')).toBeNull()
  })

  it('keeps a runtime host nested SSH target, which decides local readability', () => {
    // `repoWithFetchedOwner` stamps the runtime host and spreads the nested target through. The
    // pane pairs it with the environment (`selectRuntimeAwareSshStatus`) for reconnect state, and
    // `isNativeChatTranscriptLocalReadable` treats a null here as "this client can read it" — so
    // dropping it would send a transcript read to the wrong machine.
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

  it('resolves the row on the SSH host the worktree names when both hosts carry the id', () => {
    const state: ConnectionContextState = {
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        makeRepo({ id: 'repo-shared', connectionId: 'openclaw' }),
        makeRepo({ id: 'repo-shared', connectionId: 'm4air', path: '/srv/repo' })
      ],
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
})
