import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import {
  createTabEntryAllowAbsolutePathsSelector,
  getTabEntryAllowAbsolutePaths,
  getTabEntryFileOperationContext
} from './tab-create-entry-local-path'

const initialState = useAppStore.getInitialState()
const localWorktreeId = 'repo-local::/Users/me/repo'

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/Users/me/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-local',
    projectGroupId: 'group-local',
    name: 'Local folder',
    folderPath: '/Users/me/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-local',
    name: 'Local group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('getTabEntryAllowAbsolutePaths', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('allows absolute paths for a known local worktree', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'local'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), localWorktreeId)).toBe(true)
  })

  it('blocks absolute paths when the worktree has an SSH connectionId', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-ssh', connectionId: 'ssh-1' })],
      worktreesByRepo: {
        'repo-ssh': [
          {
            id: 'repo-ssh::/home/neil/repo',
            repoId: 'repo-ssh',
            path: '/home/neil/repo'
          } as never
        ]
      },
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), 'repo-ssh::/home/neil/repo')).toBe(
      false
    )
  })

  it('blocks absolute paths when activeRuntimeEnvironmentId is set', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [{ id: 'hub-a' } as never],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: 'hub-a' } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), localWorktreeId)).toBe(false)
  })

  it('blocks absolute paths while worktree connection ownership is unresolved', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), 'repo-missing::/tmp/repo-feature')
    ).toBe(false)
  })

  it('blocks absolute paths when the worktree is missing from a known local repo', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: { 'repo-local': [] },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), 'repo-local::/Users/me/repo-missing')
    ).toBe(false)
  })

  it('blocks absolute paths for conflicting local and paired-runtime ownership', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' }), makeRepo({ id: 'repo-runtime' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'local'
          } as never
        ],
        'repo-runtime': [
          {
            id: localWorktreeId,
            repoId: 'repo-runtime',
            path: '/Users/me/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [{ id: 'hub-a' } as never],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), localWorktreeId)).toBe(false)
  })

  it('allows positively known local folder workspaces', () => {
    const folderWorkspace = makeFolderWorkspace()
    const worktreeId = folderWorkspaceKey(folderWorkspace.id)
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup()],
      repos: [],
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), worktreeId)).toBe(true)
    expect(
      getTabEntryFileOperationContext(
        useAppStore.getState(),
        worktreeId,
        folderWorkspace.folderPath
      )
    ).toMatchObject({
      expectedExecutionHostId: 'local',
      worktreeId,
      worktreePath: folderWorkspace.folderPath
    })
  })

  it('blocks SSH-owned folder workspaces', () => {
    const folderWorkspace = makeFolderWorkspace({
      id: 'folder-ssh',
      folderPath: '/home/me/folder',
      connectionId: 'ssh-1'
    })
    const worktreeId = folderWorkspaceKey(folderWorkspace.id)
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup()],
      repos: [],
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), worktreeId)).toBe(false)
  })

  it('blocks folder workspaces until their project group owner is hydrated', () => {
    const folderWorkspace = makeFolderWorkspace()
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [],
      repos: []
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), folderWorkspaceKey(folderWorkspace.id))
    ).toBe(false)
  })

  it('blocks paired-runtime folder workspaces', () => {
    const folderWorkspace = makeFolderWorkspace()
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup({ executionHostId: 'runtime:hub-a' })],
      repos: [],
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), folderWorkspaceKey(folderWorkspace.id))
    ).toBe(false)
  })

  it('blocks folder workspaces restored from a paired runtime', () => {
    const folderWorkspace = makeFolderWorkspace()
    const worktreeId = folderWorkspaceKey(folderWorkspace.id)
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup()],
      repos: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [worktreeId]: 'runtime:hub-a'
      }
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), worktreeId)).toBe(false)
  })

  it('blocks folder workspaces whose repos infer SSH ownership', () => {
    const folderWorkspace = makeFolderWorkspace()
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup()],
      repos: [
        makeRepo({
          id: 'repo-ssh',
          path: '/Users/me/folder/repo',
          projectGroupId: 'group-local',
          connectionId: 'ssh-1'
        })
      ]
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), folderWorkspaceKey(folderWorkspace.id))
    ).toBe(false)
  })

  it('blocks folder workspaces with mixed local and SSH repo ownership', () => {
    const folderWorkspace = makeFolderWorkspace()
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      projectGroups: [makeProjectGroup()],
      repos: [
        makeRepo({
          id: 'repo-local-child',
          path: '/Users/me/folder/local',
          projectGroupId: 'group-local'
        }),
        makeRepo({
          id: 'repo-ssh-child',
          path: '/Users/me/folder/remote',
          projectGroupId: 'group-local',
          connectionId: 'ssh-1'
        })
      ]
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), folderWorkspaceKey(folderWorkspace.id))
    ).toBe(false)
  })

  it('does not repeat owner resolution for unrelated store writes', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'local'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })
    const state = useAppStore.getState()
    const getKnownWorktreeById = vi.fn(state.getKnownWorktreeById)
    const selector = createTabEntryAllowAbsolutePathsSelector(localWorktreeId)
    const selectedState = { ...state, getKnownWorktreeById }

    expect(selector(selectedState)).toBe(true)
    for (let index = 0; index < 1_000; index += 1) {
      expect(selector({ ...selectedState, pendingToastCount: index } as never)).toBe(true)
    }

    expect(getKnownWorktreeById).toHaveBeenCalledTimes(1)
  })

  it('recomputes when an ownership-causal slice changes', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'local'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })
    const state = useAppStore.getState()
    const selector = createTabEntryAllowAbsolutePathsSelector(localWorktreeId)

    expect(selector(state)).toBe(true)
    expect(
      selector({
        ...state,
        worktreesByRepo: {
          'repo-local': [
            {
              id: localWorktreeId,
              repoId: 'repo-local',
              path: '/Users/me/repo',
              hostId: 'runtime:hub-a',
              runtimeOwnerEnvironmentId: 'hub-a'
            } as never
          ]
        },
        runtimeEnvironments: [{ id: 'hub-a' } as never]
      })
    ).toBe(false)
  })

  it('skips owner resolution until an absolute query needs it', () => {
    const state = useAppStore.getState()
    const getKnownWorktreeById = vi.fn(state.getKnownWorktreeById)
    const selector = createTabEntryAllowAbsolutePathsSelector(localWorktreeId, { skip: true })

    expect(selector({ ...state, getKnownWorktreeById })).toBe(false)
    expect(getKnownWorktreeById).not.toHaveBeenCalled()
  })
})
