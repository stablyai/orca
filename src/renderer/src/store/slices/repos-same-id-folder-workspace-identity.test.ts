import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { getFolderWorkspaceRowKey } from '../../../../shared/folder-workspaces'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildHostIdByWorktreeId } from '../../lib/workspace-session-host-persistence'
import { computeRenderedSidebarWorktreeOrder } from '../../components/sidebar/rendered-sidebar-worktree-order'
import { getContextMenuWorktreeMetaId } from '../../components/sidebar/WorktreeContextMenu'
import { collectActiveDashboardWorkspaces } from '../../components/dashboard/dashboard-snapshot-workspaces'
import {
  getAgentMapFolderComposerProjectGroupId,
  resolveAgentMapProjectContextTarget
} from '../../components/dashboard-popout/AgentMapProjectContextMenu'
import {
  getExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '../../lib/worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from '../../lib/worktree-operation-route'
import {
  getFolderWorkspaceCandidateRepos,
  getFolderWorkspaceConnectionId
} from '../../lib/folder-workspace-connection'
import { createTestStore } from './store-test-helpers'

function makeGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: overrides.id ?? 'same-group',
    name: overrides.name ?? 'Same Group',
    parentPath: overrides.parentPath ?? '/workspace',
    connectionId: overrides.connectionId ?? null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...(overrides.executionHostId ? { executionHostId: overrides.executionHostId } : {})
  }
}

function makeFolder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: overrides.id ?? 'same-id',
    projectGroupId: overrides.projectGroupId ?? 'same-group',
    name: overrides.name ?? 'Workspace',
    folderPath: overrides.folderPath ?? '/workspace/folder',
    connectionId: overrides.connectionId ?? null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(overrides.executionHostId ? { executionHostId: overrides.executionHostId } : {})
  }
}

describe('same-id cross-host folder workspace identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps both owner-qualified folders in closed-sidebar shortcut order', () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
      ],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ]
    })

    expect(computeRenderedSidebarWorktreeOrder(store.getState(), [])).toEqual([
      folderWorkspaceKey('same-id', 'local'),
      folderWorkspaceKey('same-id', 'runtime:env-1')
    ])
  })

  it('deletes only the owner-qualified folder row and its session keys', async () => {
    const local = makeFolder({
      name: 'Local',
      folderPath: '/local/folder',
      connectionId: null,
      executionHostId: 'local'
    })
    const remote = makeFolder({
      name: 'Remote',
      folderPath: '/remote/folder',
      connectionId: null,
      executionHostId: 'runtime:env-1'
    })
    const store = createTestStore()
    const purgeWorktreeTerminalState = vi.fn()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/remote' })
      ],
      folderWorkspaces: [local, remote],
      folderWorkspacePathStatuses: {
        'local:folder-workspace:["local","same-id"]': {
          status: { path: '/local/folder', exists: true },
          checkedAt: 1,
          requestSnapshot: 'local'
        },
        'local:folder-workspace:["runtime:env-1","same-id"]': {
          status: { path: '/remote/folder', exists: true },
          checkedAt: 1,
          requestSnapshot: 'remote'
        }
      },
      purgeWorktreeTerminalState
    })

    const deleteFolderWorkspace = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      api: {
        folderWorkspaces: {
          delete: deleteFolderWorkspace
        }
      }
    })

    await expect(
      store.getState().deleteFolderWorkspace('same-id', { ownerHostId: 'local' })
    ).resolves.toBe(true)

    const remaining = store.getState().folderWorkspaces
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.executionHostId).toBe('runtime:env-1')
    expect(deleteFolderWorkspace).toHaveBeenCalledWith({
      folderWorkspaceId: 'same-id',
      ownerHostId: 'local'
    })
    expect(purgeWorktreeTerminalState).toHaveBeenCalledWith([
      folderWorkspaceKey('same-id', 'local')
    ])
    expect(Object.keys(store.getState().folderWorkspacePathStatuses)).toEqual([
      'local:folder-workspace:["runtime:env-1","same-id"]'
    ])
  })

  it('keeps path-status cache keys independent per owner for same folder id', () => {
    const store = createTestStore()
    const localKey = store
      .getState()
      .getFolderWorkspacePathStatusCacheKey(
        { scope: 'folder-workspace', folderWorkspaceId: 'same-id' },
        { ownerHostId: 'local' }
      )
    const remoteKey = store
      .getState()
      .getFolderWorkspacePathStatusCacheKey(
        { scope: 'folder-workspace', folderWorkspaceId: 'same-id' },
        { ownerHostId: 'runtime:env-1' }
      )
    expect(localKey).not.toBe(remoteKey)
    expect(localKey).toContain('["local","same-id"]')
    expect(remoteKey).toContain('["runtime:env-1","same-id"]')
  })

  it('keeps restored ownership until the matching same-id group catalog arrives', async () => {
    const remoteKey = folderWorkspaceKey('same-id', 'runtime:env-1')
    const store = createTestStore()
    store.setState({
      projectGroups: [makeGroup({ executionHostId: 'local' })],
      folderWorkspaces: [
        makeFolder({
          executionHostId: 'runtime:env-1',
          folderPath: '/remote/folder'
        })
      ],
      restoredRuntimeHostIdByWorkspaceSessionKey: { [remoteKey]: 'runtime:env-1' }
    })
    vi.stubGlobal('window', {
      api: {
        folderWorkspaces: { list: vi.fn().mockResolvedValue([]) },
        runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) }
      }
    })

    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      [remoteKey]: 'runtime:env-1'
    })
  })

  it('keeps the legacy bare folder session identity on unambiguous activation', () => {
    const store = createTestStore()
    const bareKey = folderWorkspaceKey('folder-workspace-1')
    const folder = makeFolder({
      id: 'folder-workspace-1',
      projectGroupId: 'group-a',
      connectionId: null,
      executionHostId: 'local',
      folderPath: '/local/folder'
    })
    store.setState({
      projectGroups: [makeGroup({ id: 'group-a', executionHostId: 'local', parentPath: '/local' })],
      folderWorkspaces: [folder],
      // Why: reconnectable pty keeps the tab out of orphan cleanup during activation reconcile.
      tabsByWorktree: {
        [bareKey]: [
          {
            id: 'legacy-tab',
            ptyId: 'pty-legacy',
            worktreeId: bareKey,
            title: 'Legacy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'legacy-tab': ['pty-legacy'] },
      activeTabIdByWorktree: { [bareKey]: 'legacy-tab' }
    })

    store.getState().setActiveFolderWorkspace('folder-workspace-1', 'local')

    const state = store.getState()
    expect(state.activeWorkspaceKey).toBe(bareKey)
    expect(state.activeWorktreeId).toBe(bareKey)
    expect(state.tabsByWorktree[bareKey]?.[0]?.id).toBe('legacy-tab')
    expect(state.activeTabIdByWorktree[bareKey]).toBe('legacy-tab')
    expect(state.activeTabId).toBe('legacy-tab')
  })

  it('does not reuse an unowned legacy session when an id becomes ambiguous', () => {
    const store = createTestStore()
    const bareKey = folderWorkspaceKey('same-id')
    const localKey = folderWorkspaceKey('same-id', 'local')
    store.setState({
      projectGroups: [
        makeGroup({ id: 'same-group', executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ id: 'same-group', executionHostId: 'runtime:env-1', parentPath: '/remote' })
      ],
      folderWorkspaces: [
        makeFolder({
          id: 'same-id',
          name: 'Local',
          executionHostId: 'local',
          folderPath: '/local/folder'
        }),
        makeFolder({
          id: 'same-id',
          name: 'Remote',
          executionHostId: 'runtime:env-1',
          folderPath: '/remote/folder'
        })
      ],
      tabsByWorktree: {
        [bareKey]: [
          {
            id: 'legacy-tab',
            ptyId: 'pty-legacy',
            worktreeId: bareKey,
            title: 'Legacy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'legacy-tab': ['pty-legacy'] }
    })

    store.getState().setActiveFolderWorkspace('same-id', 'local')
    expect(store.getState().activeWorkspaceKey).toBe(localKey)
    expect(store.getState().activeWorktreeId).toBe(localKey)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('local')
    expect(store.getState().tabsByWorktree[bareKey]?.[0]?.id).toBe('legacy-tab')
    expect(store.getState().tabsByWorktree[localKey]).toBeUndefined()
  })

  it('migrates a legacy session when its active owner proves the alias', () => {
    const store = createTestStore()
    const bareKey = folderWorkspaceKey('same-id')
    const localKey = folderWorkspaceKey('same-id', 'local')
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
      ],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ],
      activeWorktreeId: bareKey,
      activeWorkspaceKey: bareKey,
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: { [bareKey]: [] },
      activeFileIdByWorktree: { [bareKey]: null },
      browserTabsByWorktree: { [bareKey]: [] },
      groupsByWorktree: { [bareKey]: [] },
      unifiedTabsByWorktree: { [bareKey]: [] }
    })

    store.getState().setActiveFolderWorkspace('same-id', 'local')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(localKey)
    expect(state.tabsByWorktree).toHaveProperty(localKey)
    expect(state.activeFileIdByWorktree).toHaveProperty(localKey)
    expect(state.browserTabsByWorktree).toHaveProperty(localKey)
    expect(state.groupsByWorktree).toHaveProperty(localKey)
    expect(state.unifiedTabsByWorktree).toHaveProperty(localKey)
    expect(state.tabsByWorktree).not.toHaveProperty(bareKey)
  })

  it('does not overwrite a canonical owner session with a proven legacy alias', () => {
    const store = createTestStore()
    const bareKey = folderWorkspaceKey('same-id')
    const localKey = folderWorkspaceKey('same-id', 'local')
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
      ],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ],
      activeWorktreeId: bareKey,
      activeWorkspaceKey: bareKey,
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: {
        [bareKey]: [],
        [localKey]: [
          {
            id: 'canonical-tab',
            ptyId: 'pty-canonical',
            worktreeId: localKey,
            title: 'Canonical',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'canonical-tab': ['pty-canonical'] }
    })

    store.getState().setActiveFolderWorkspace('same-id', 'local')

    expect(store.getState().activeWorktreeId).toBe(localKey)
    expect(store.getState().tabsByWorktree[localKey]?.[0]?.id).toBe('canonical-tab')
    expect(store.getState().tabsByWorktree).toHaveProperty(bareKey)
  })

  it('keeps same-id owner sessions isolated', () => {
    const store = createTestStore()
    const localKey = folderWorkspaceKey('same-id', 'local')
    const runtimeKey = folderWorkspaceKey('same-id', 'runtime:env-1')
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
      ],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ],
      tabsByWorktree: { [localKey]: [], [runtimeKey]: [] }
    })

    store.getState().setActiveFolderWorkspace('same-id', 'local')
    expect(store.getState().activeWorktreeId).toBe(localKey)
    store.getState().setActiveFolderWorkspace('same-id', 'runtime:env-1')
    expect(store.getState().activeWorktreeId).toBe(runtimeKey)
    expect(Object.keys(store.getState().tabsByWorktree).sort()).toEqual(
      [localKey, runtimeKey].sort()
    )
  })

  it('round-trips owner-qualified keys and persists each runtime owner separately', () => {
    const localKey = folderWorkspaceKey('same:id', 'local')
    const runtimeKey = folderWorkspaceKey('same:id', 'runtime:env-1')
    expect(parseWorkspaceKey(runtimeKey)).toEqual({
      type: 'folder',
      folderWorkspaceId: 'same:id',
      ownerHostId: 'runtime:env-1'
    })
    const getHostId = buildHostIdByWorktreeId({
      repos: [],
      projectGroups: [
        { id: 'same-group', executionHostId: 'local' },
        { id: 'same-group', executionHostId: 'runtime:env-1' }
      ],
      folderWorkspaces: [
        { id: 'same:id', projectGroupId: 'same-group', executionHostId: 'local' },
        { id: 'same:id', projectGroupId: 'same-group', executionHostId: 'runtime:env-1' }
      ],
      worktreesByRepo: {}
    })

    expect(getHostId(localKey)).toBe('local')
    expect(getHostId(runtimeKey)).toBe('runtime:env-1')
  })

  it('routes inactive owner-qualified folder sessions through their exact owner', () => {
    const store = createTestStore()
    const localKey = folderWorkspaceKey('same-id', 'local')
    const runtimeKey = folderWorkspaceKey('same-id', 'runtime:env-1')
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local', parentPath: '/local' }),
        makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
      ],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ],
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null
    })
    const state = store.getState()

    expect(getRuntimeEnvironmentIdForWorktree(state, localKey)).toBeNull()
    expect(getRuntimeEnvironmentIdForWorktree(state, runtimeKey)).toBe('env-1')
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, runtimeKey)).toBe('env-1')
    expect(getExecutionHostIdForWorktree(state, localKey)).toBe('local')
    expect(getExecutionHostIdForWorktree(state, runtimeKey)).toBe('runtime:env-1')
    expect(resolveWorktreeOperationRouteResult(state, runtimeKey)).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:env-1', runtimeEnvironmentId: 'env-1' }
    })
  })

  it('keeps same-id dashboard folder projects and composer targets owner-qualified', () => {
    const localGroup = makeGroup({ executionHostId: 'local', parentPath: '/local' })
    const runtimeGroup = makeGroup({ executionHostId: 'runtime:env-1', parentPath: '/runtime' })
    const state = {
      repos: [],
      worktreesByRepo: {},
      projectGroups: [localGroup, runtimeGroup],
      folderWorkspaces: [
        makeFolder({ executionHostId: 'local', folderPath: '/local/folder' }),
        makeFolder({ executionHostId: 'runtime:env-1', folderPath: '/runtime/folder' })
      ]
    }
    const workspaces = collectActiveDashboardWorkspaces(state)

    expect(workspaces.map((workspace) => workspace.projectId)).toEqual([
      `folder-workspace:${getAgentMapFolderComposerProjectGroupId(localGroup)}`,
      `folder-workspace:${getAgentMapFolderComposerProjectGroupId(runtimeGroup)}`
    ])
    expect(workspaces.map((workspace) => workspace.worktree.id)).toEqual([
      folderWorkspaceKey('same-id', 'local'),
      folderWorkspaceKey('same-id', 'runtime:env-1')
    ])
    expect(
      workspaces.map((workspace) =>
        resolveAgentMapProjectContextTarget({
          projectId: workspace.projectId,
          repos: [],
          projectGroups: state.projectGroups
        })
      )
    ).toEqual([
      { kind: 'folder', group: localGroup },
      { kind: 'folder', group: runtimeGroup }
    ])
    expect(
      resolveAgentMapProjectContextTarget({
        projectId: `folder-workspace:${localGroup.id}`,
        repos: [],
        projectGroups: [localGroup]
      })
    ).toEqual({ kind: 'folder', group: localGroup })
  })

  it('keeps legacy bare folder ids containing colons intact', () => {
    expect(parseWorkspaceKey('folder:legacy:id')).toEqual({
      type: 'folder',
      folderWorkspaceId: 'legacy:id'
    })
  })

  it('keeps host-shaped legacy ids distinct from owner-qualified keys', () => {
    const legacyKey = folderWorkspaceKey('local:same-id')
    const qualifiedKey = folderWorkspaceKey('same-id', 'local')
    const legacyRowKey = getFolderWorkspaceRowKey(makeFolder({ id: 'local:same-id' }))
    const qualifiedRowKey = getFolderWorkspaceRowKey(
      makeFolder({ executionHostId: 'local' }),
      [],
      true
    )

    expect(legacyKey).not.toBe(qualifiedKey)
    expect(legacyRowKey).not.toBe(qualifiedRowKey)
    expect(parseWorkspaceKey(legacyKey)).toEqual({
      type: 'folder',
      folderWorkspaceId: 'local:same-id'
    })
    expect(parseWorkspaceKey(qualifiedKey)).toEqual({
      type: 'folder',
      folderWorkspaceId: 'same-id',
      ownerHostId: 'local'
    })
    for (const reservedId of ['@owner:raw', '@id:raw']) {
      expect(parseWorkspaceKey(folderWorkspaceKey(reservedId))).toEqual({
        type: 'folder',
        folderWorkspaceId: reservedId
      })
    }
  })

  it('routes folder metadata writes through the selected owner', async () => {
    const local = makeFolder({ executionHostId: 'local' })
    const ssh = makeFolder({
      connectionId: 'builder',
      executionHostId: undefined,
      folderPath: '/remote/folder'
    })
    const update = vi.fn().mockResolvedValue({ ...ssh, comment: 'SSH note' })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local' }),
        makeGroup({ connectionId: 'builder', executionHostId: undefined })
      ],
      folderWorkspaces: [local, ssh]
    })
    vi.stubGlobal('window', { api: { folderWorkspaces: { update } } })
    await expect(
      store
        .getState()
        .updateWorktreeMeta(folderWorkspaceKey('same-id', 'ssh:builder'), { comment: 'SSH note' })
    ).resolves.toEqual({ ok: true })

    expect(update).toHaveBeenCalledWith({
      folderWorkspaceId: 'same-id',
      ownerHostId: 'ssh:builder',
      updates: { comment: 'SSH note', lastActivityAt: expect.any(Number) }
    })
  })

  it('qualifies context-menu metadata keys with the selected row owner', () => {
    expect(getContextMenuWorktreeMetaId({ id: 'folder:same-id', hostId: 'runtime:env-1' })).toBe(
      folderWorkspaceKey('same-id', 'runtime:env-1')
    )
  })

  it('forwards the selected folder owner through local update IPC', async () => {
    const local = makeFolder({ executionHostId: 'local' })
    const remote = makeFolder({ executionHostId: 'runtime:env-1' })
    const update = vi.fn().mockResolvedValue({ ...local, name: 'Updated' })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local' }),
        makeGroup({ executionHostId: 'runtime:env-1' })
      ],
      folderWorkspaces: [local, remote]
    })
    vi.stubGlobal('window', { api: { folderWorkspaces: { update } } })

    await expect(
      store
        .getState()
        .updateFolderWorkspace('same-id', { name: 'Updated' }, { executionHostId: 'local' })
    ).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith({
      folderWorkspaceId: 'same-id',
      ownerHostId: 'local',
      updates: { name: 'Updated' }
    })
  })

  it('routes unread and activity metadata to only the active same-id folder owner', async () => {
    const local = { ...makeFolder({ executionHostId: 'local' }), isUnread: true }
    const ssh = makeFolder({
      connectionId: 'builder',
      executionHostId: undefined,
      folderPath: '/remote/folder'
    })
    const update = vi
      .fn()
      .mockImplementation(
        async ({
          ownerHostId,
          updates
        }: {
          ownerHostId: string
          updates: Partial<FolderWorkspace>
        }) => ({ ...(ownerHostId === 'local' ? local : ssh), ...updates })
      )
    const store = createTestStore()
    const workspaceKey = folderWorkspaceKey('same-id')
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local' }),
        makeGroup({ connectionId: 'builder', parentPath: '/remote' })
      ],
      folderWorkspaces: [local, ssh],
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: 'local'
    })
    vi.stubGlobal('window', { api: { folderWorkspaces: { update } } })

    store.getState().clearWorktreeUnread(workspaceKey)
    expect(store.getState().folderWorkspaces.map((workspace) => workspace.isUnread)).toEqual([
      false,
      false
    ])

    store.setState({ activeWorkspaceExecutionHostId: 'ssh:builder' })
    store.getState().markWorktreeUnread(workspaceKey)
    store.getState().bumpWorktreeActivity(workspaceKey)
    store.getState().bumpWorktreeActivity(workspaceKey)
    store.setState({ activeWorkspaceExecutionHostId: 'local' })

    const [updatedLocal, updatedSsh] = store.getState().folderWorkspaces
    expect(updatedLocal).toMatchObject({ isUnread: false, lastActivityAt: 1 })
    expect(updatedSsh).toMatchObject({ isUnread: true })
    expect(updatedSsh?.lastActivityAt).toBeGreaterThan(1)
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(4), { timeout: 1_500 })
    expect(update.mock.calls.map(([args]) => args.ownerHostId)).toEqual([
      'local',
      'ssh:builder',
      'ssh:builder',
      'ssh:builder'
    ])
  })

  it('fails closed for passive folder metadata when a same-id owner is not active', () => {
    const local = { ...makeFolder({ executionHostId: 'local' }), isUnread: true }
    const ssh = makeFolder({
      connectionId: 'builder',
      executionHostId: undefined,
      folderPath: '/remote/folder'
    })
    const updateFolderWorkspace = vi.fn()
    const store = createTestStore()
    const workspaceKey = folderWorkspaceKey('same-id')
    store.setState({ folderWorkspaces: [local, ssh], updateFolderWorkspace })

    store.getState().clearWorktreeUnread(workspaceKey)
    store.getState().markWorktreeUnread(workspaceKey)
    store.getState().bumpWorktreeActivity(workspaceKey)

    expect(store.getState().folderWorkspaces).toEqual([local, ssh])
    expect(updateFolderWorkspace).not.toHaveBeenCalled()

    store.getState().markWorktreeUnread(folderWorkspaceKey('same-id', 'ssh:builder'))

    expect(store.getState().folderWorkspaces.map((workspace) => workspace.isUnread)).toEqual([
      true,
      true
    ])
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      'same-id',
      expect.objectContaining({ isUnread: true }),
      { executionHostId: 'ssh:builder' }
    )
  })

  it('clears unread on only the owner selected by generic folder activation', async () => {
    const local = { ...makeFolder({ executionHostId: 'local' }), isUnread: true }
    const ssh = {
      ...makeFolder({
        connectionId: 'builder',
        executionHostId: undefined,
        folderPath: '/remote/folder'
      }),
      isUnread: true
    }
    const update = vi.fn().mockResolvedValue({ ...ssh, isUnread: false })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local' }),
        makeGroup({ connectionId: 'builder', parentPath: '/remote' })
      ],
      folderWorkspaces: [local, ssh]
    })
    vi.stubGlobal('window', { api: { folderWorkspaces: { update } } })

    expect(store.getState().setActiveWorktree(folderWorkspaceKey('same-id'), 'ssh:builder')).toBe(
      true
    )

    expect(store.getState().folderWorkspaces.map((workspace) => workspace.isUnread)).toEqual([
      true,
      false
    ])
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[0]).toMatchObject({ ownerHostId: 'ssh:builder' })
  })

  it('reconciles a failed same-id update from the selected owner row', async () => {
    const local = makeFolder({ name: 'Local current', executionHostId: 'local' })
    const ssh = makeFolder({
      name: 'SSH current',
      folderPath: '/remote/folder',
      connectionId: 'builder'
    })
    const list = vi.fn().mockResolvedValue([
      { ...local, name: 'Local persisted' },
      { ...ssh, name: 'SSH persisted' }
    ])
    const update = vi.fn().mockResolvedValue(null)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        makeGroup({ executionHostId: 'local' }),
        makeGroup({ connectionId: 'builder', parentPath: '/remote' })
      ],
      folderWorkspaces: [local, ssh]
    })
    vi.stubGlobal('window', { api: { folderWorkspaces: { list, update } } })

    await expect(
      store
        .getState()
        .updateFolderWorkspace('same-id', { name: 'Rejected' }, { executionHostId: 'ssh:builder' })
    ).resolves.toBe(false)

    expect(store.getState().folderWorkspaces.map((workspace) => workspace.name)).toEqual([
      'Local current',
      'SSH persisted'
    ])
  })

  it('resolves connection consumers through the exact active folder owner', () => {
    const localGroup = makeGroup({ executionHostId: 'local', parentPath: '/local' })
    const sshGroup = makeGroup({ connectionId: 'builder', parentPath: '/remote' })
    const localFolder = makeFolder({ executionHostId: 'local', folderPath: '/local/folder' })
    const sshFolder = makeFolder({ connectionId: 'builder', folderPath: '/remote/folder' })
    const localRepo: Repo = {
      id: 'same-repo',
      path: '/local/folder/repo',
      displayName: 'Local repo',
      badgeColor: '#000',
      addedAt: 1,
      projectGroupId: localGroup.id,
      executionHostId: 'local'
    }
    const sshRepo: Repo = {
      ...localRepo,
      path: '/remote/folder/repo',
      displayName: 'SSH repo',
      connectionId: 'builder',
      executionHostId: undefined
    }
    const state = {
      folderWorkspaces: [localFolder, sshFolder],
      projectGroups: [localGroup, sshGroup],
      repos: [localRepo, sshRepo]
    }

    expect(getFolderWorkspaceConnectionId(state, 'same-id')).toBeUndefined()
    expect(getFolderWorkspaceConnectionId(state, 'same-id', 'local')).toBeNull()
    expect(getFolderWorkspaceConnectionId(state, 'same-id', 'ssh:builder')).toBe('builder')
    expect(
      getFolderWorkspaceCandidateRepos(
        {
          ...state,
          activeWorktreeId: folderWorkspaceKey('same-id', 'ssh:builder'),
          activeWorkspaceExecutionHostId: 'ssh:builder'
        },
        'same-id'
      )
    ).toEqual([sshRepo])
    expect(
      getFolderWorkspaceConnectionId(
        {
          ...state,
          activeWorktreeId: folderWorkspaceKey('same-id', 'ssh:builder'),
          activeWorkspaceExecutionHostId: 'ssh:builder'
        },
        'same-id'
      )
    ).toBe('builder')
  })
})
