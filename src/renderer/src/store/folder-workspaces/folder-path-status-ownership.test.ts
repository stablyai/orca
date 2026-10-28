import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  getFolderWorkspaceStatusRequestDependencies,
  getFolderWorkspaceStatusRequestSnapshot
} from './folder-path-status'
import { createProjectGroup } from '../../../../shared/project-groups'
import { makeRepo, makeFolderWorkspace } from '@/components/worktree-jump-palette-test-fixtures'
import { createTestStore } from '../slices/store-test-helpers'

const mocks = vi.hoisted(() => ({ getPathStatus: vi.fn(), callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeRpcClient>()
  return { ...original, callRuntimeRpc: mocks.callRuntimeRpc }
})

const owners = [
  { executionHostId: 'local', runtimeEnvironmentId: null, path: '/local/folder' },
  { executionHostId: 'runtime:builder', runtimeEnvironmentId: 'builder', path: '/remote/folder' }
] as const

const folders = owners.map((owner) =>
  makeFolderWorkspace({ executionHostId: owner.executionHostId, folderPath: owner.path })
)
const request = { scope: 'folder-workspace', folderWorkspaceId: folders[0].id } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: { folderWorkspaces: { getPathStatus: mocks.getPathStatus } }
  })
})

describe('folder path status ownership', () => {
  it.each(owners)(
    'keeps the $executionHostId cache valid after catalog reordering',
    async (owner) => {
      const store = createTestStore()
      store.setState({ folderWorkspaces: folders })
      for (const candidate of owners) {
        const status: FolderWorkspacePathStatus = {
          path: candidate.path,
          exists: candidate.executionHostId === 'local',
          ...(candidate.executionHostId === 'local' ? {} : { reason: 'missing' as const })
        }
        mocks.getPathStatus.mockResolvedValue(status)
        mocks.callRuntimeRpc.mockResolvedValue({ status })
        await store.getState().fetchFolderWorkspacePathStatus(request, candidate)
      }

      store.setState({ folderWorkspaces: folders.toReversed() })

      expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toMatchObject({
        path: owner.path,
        exists: owner.executionHostId === 'local'
      })
      expect(mocks.getPathStatus).toHaveBeenCalledOnce()
      expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'environment', environmentId: 'builder' },
        'folderWorkspace.getPathStatus',
        request,
        { timeoutMs: 15_000 }
      )
    }
  )

  it.each(owners)(
    'rejects a delayed $executionHostId error after its folder path changes',
    async (owner) => {
      const store = createTestStore()
      // The selected folder is second, so a bare-id lookup would fingerprint the other host.
      store.setState({
        folderWorkspaces: [
          ...folders.filter((folder) => folder.executionHostId !== owner.executionHostId),
          ...folders.filter((folder) => folder.executionHostId === owner.executionHostId)
        ]
      })
      const pending = Promise.withResolvers<FolderWorkspacePathStatus>()
      mocks.getPathStatus.mockReturnValue(pending.promise)
      mocks.callRuntimeRpc.mockImplementation(async () => ({ status: await pending.promise }))
      const oldProbe = store.getState().fetchFolderWorkspacePathStatus(request, owner)
      const repairedPath = `${owner.path}-repaired`
      store.setState((state) => ({
        folderWorkspaces: state.folderWorkspaces.map((folder) =>
          folder.executionHostId === owner.executionHostId
            ? { ...folder, folderPath: repairedPath }
            : folder
        ),
        folderWorkspacePathStatuses: {}
      }))
      const repairedStatus = { path: repairedPath, exists: true }
      mocks.getPathStatus.mockResolvedValue(repairedStatus)
      mocks.callRuntimeRpc.mockResolvedValue({ status: repairedStatus })
      await store.getState().fetchFolderWorkspacePathStatus(request, { ...owner, force: true })

      pending.resolve({ path: owner.path, exists: false, reason: 'missing' })
      await oldProbe

      expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toEqual(
        repairedStatus
      )
    }
  )

  it('does not borrow a same-id folder when the requested host has no owner', async () => {
    const store = createTestStore()
    store.setState({ folderWorkspaces: folders })
    mocks.callRuntimeRpc.mockResolvedValue({
      status: { path: '/unrelated/folder', exists: false, reason: 'missing' }
    })
    const owner = { runtimeEnvironmentId: 'missing-host' }

    await store.getState().fetchFolderWorkspacePathStatus(request, owner)

    expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toBeNull()
    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it.each(owners)(
    'checks the $executionHostId project group when its id exists on another host',
    async (owner) => {
      const groups: ProjectGroup[] = owners.map((candidate) => ({
        id: 'group-1',
        name: 'Research',
        parentPath: candidate.path,
        parentGroupId: null,
        executionHostId: candidate.executionHostId,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }))
      const store = createTestStore()
      store.setState({ projectGroups: groups })
      const groupRequest = { scope: 'project-group', projectGroupId: 'group-1' } as const
      const status = { path: owner.path, exists: true }
      mocks.getPathStatus.mockResolvedValue(status)
      mocks.callRuntimeRpc.mockResolvedValue({ status })
      await store.getState().fetchFolderWorkspacePathStatus(groupRequest, owner)

      store.setState({ projectGroups: groups.toReversed() })

      expect(store.getState().getFreshFolderWorkspacePathStatus(groupRequest, owner)).toEqual(
        status
      )
    }
  )
})

describe('shared folder snapshot candidate extraction', () => {
  it('preserves exact owner, descendant, contained-path and explicit-target snapshot bytes', () => {
    const store = createTestStore()
    const group = {
      ...createProjectGroup({
        name: 'Root',
        parentPath: '/root',
        createdFrom: 'folder-scan',
        tabOrder: 0,
        now: 1
      }),
      id: 'root',
      executionHostId: 'local',
      connectionId: 'C'
    }
    const child = {
      ...group,
      id: 'child',
      parentGroupId: 'root',
      parentPath: '/elsewhere',
      connectionId: null
    }
    const repos: Repo[] = [
      {
        ...makeRepo(),
        id: 'nested',
        path: '/outside/repo',
        projectGroupId: 'child',
        connectionId: 'A',
        executionHostId: 'local'
      },
      {
        ...makeRepo(),
        id: 'contained',
        path: '/root/repo',
        connectionId: 'B',
        executionHostId: 'local'
      },
      {
        ...makeRepo(),
        id: 'foreign',
        path: '/root/repo',
        connectionId: 'Z',
        executionHostId: 'runtime:builder'
      }
    ]
    const folder = makeFolderWorkspace({
      id: 'folder',
      projectGroupId: 'root',
      folderPath: '/root',
      executionHostId: 'local'
    })
    store.setState({
      projectGroups: [
        group,
        child,
        { ...group, executionHostId: 'runtime:builder', parentPath: '/remote' }
      ],
      folderWorkspaces: [
        folder,
        { ...folder, executionHostId: 'runtime:builder', folderPath: '/remote' }
      ],
      repos,
      sshConnectionStates: new Map([
        ['A', { targetId: 'A', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })
    const options = { runtimeEnvironmentId: null }
    const groupRequest = { scope: 'project-group', projectGroupId: 'root' } as const
    const folderRequest = { scope: 'folder-workspace', folderWorkspaceId: 'folder' } as const
    const expected = [
      '/root',
      'root',
      'C',
      'local',
      'A:connected|B:missing|C:missing',
      'contained:/root/repo::B:local|nested:/outside/repo:child:A:local'
    ].join('\0')
    for (const request of [groupRequest, folderRequest]) {
      const dependencies = getFolderWorkspaceStatusRequestDependencies(
        store.getState(),
        request,
        options
      )
      expect(dependencies?.relevantConnectionIds).toEqual(new Set(['C', 'A', 'B']))
      expect(getFolderWorkspaceStatusRequestSnapshot(store.getState(), request, options)).toBe(
        expected
      )
    }
    expect(
      getFolderWorkspaceStatusRequestSnapshot(store.getState(), groupRequest, {
        runtimeEnvironmentId: 'builder'
      })
    ).toBe(['/remote', 'root', 'C', 'runtime:builder', 'C:missing', ''].join('\0'))
    const pathRequest = { scope: 'path', path: '/root', connectionId: 'C' } as const
    expect(getFolderWorkspaceStatusRequestSnapshot(store.getState(), pathRequest, options)).toBe(
      ['/root', '', 'C', 'local', 'B:missing|C:missing', 'contained:/root/repo::B:local'].join('\0')
    )
    // Reordering cannot change the sorted token or request ownership.
    store.setState((state) => ({
      repos: state.repos.toReversed(),
      projectGroups: state.projectGroups.toReversed(),
      folderWorkspaces: state.folderWorkspaces.toReversed()
    }))
    expect(getFolderWorkspaceStatusRequestSnapshot(store.getState(), folderRequest, options)).toBe(
      expected
    )
    store.setState({ projectGroups: [group, { ...child, parentGroupId: null }] })
    expect(getFolderWorkspaceStatusRequestSnapshot(store.getState(), groupRequest, options)).toBe(
      ['/root', 'root', 'C', 'local', 'B:missing|C:missing', 'contained:/root/repo::B:local'].join(
        '\0'
      )
    )
    store.setState({
      repos: repos.map((repo) => ({ ...repo, path: '/moved', projectGroupId: null }))
    })
    expect(getFolderWorkspaceStatusRequestSnapshot(store.getState(), groupRequest, options)).toBe(
      ['/root', 'root', 'C', 'local', 'C:missing', ''].join('\0')
    )
    store.setState({ folderWorkspaces: [] })
    expect(
      getFolderWorkspaceStatusRequestDependencies(store.getState(), folderRequest, options)
    ).toBeNull()
    expect(
      getFolderWorkspaceStatusRequestSnapshot(store.getState(), folderRequest, options)
    ).toBeNull()
    store.setState({ projectGroups: [group, group] })
    expect(
      getFolderWorkspaceStatusRequestSnapshot(store.getState(), groupRequest, options)
    ).toBeNull()
    store.setState({ projectGroups: [] })
    expect(
      getFolderWorkspaceStatusRequestSnapshot(store.getState(), groupRequest, options)
    ).toBeNull()
    store.setState({ projectGroups: [group] })
    expect(
      getFolderWorkspaceStatusRequestDependencies(store.getState(), groupRequest, options)
        ?.relevantConnectionIds
    ).toEqual(new Set(['C']))
  })
})
