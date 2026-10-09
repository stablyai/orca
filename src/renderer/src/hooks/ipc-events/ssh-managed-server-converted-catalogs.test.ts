import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeWorktree } from '../../store/slices/store-test-helpers'
import { buildBrowserPage } from '../../store/slices/browser-page-records'

const store = createTestStore()
vi.mock('../../store', () => ({ useAppStore: store }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const { applySshManagedServerTransition } = await import('./ssh-managed-server-state-effects')

const repo: Repo = {
  id: 'repo-1',
  path: '/root/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
const group: ProjectGroup = {
  id: 'group-1',
  name: 'Folders',
  parentPath: '/root',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const folder: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'notes',
  folderPath: '/root/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const worktreeId = 'repo-1::/root/repo'

function serverReply(args: RuntimeEnvironmentCallRequest): unknown {
  const results: Record<string, unknown> = {
    'repo.list': { repos: [repo] },
    'projectGroup.list': { groups: [group] },
    'folderWorkspace.list': { folderWorkspaces: [folder] }
  }
  return (
    createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
      id: 'rpc',
      ok: true,
      result: results[args.method] ?? { projects: [], setups: [] },
      _meta: { runtimeId: 'orcad' }
    }
  )
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  // Main hides the retained relay-era rows, so its own lists come back empty.
  vi.stubGlobal('window', {
    api: {
      cache: { setGitHub: vi.fn(async () => undefined) },
      repos: { list: vi.fn(async () => []) },
      projects: { list: vi.fn(async () => []), listHostSetups: vi.fn(async () => []) },
      projectGroups: { list: vi.fn(async () => []) },
      folderWorkspaces: { list: vi.fn(async () => []) },
      runtimeEnvironments: {
        list: vi.fn(async () => [{ id: 'env-1', name: 'Box server' }]),
        call: vi.fn(async (args: RuntimeEnvironmentCallRequest) => serverReply(args))
      }
    },
    dispatchEvent: vi.fn()
  })
  // What the renderer held for the host before it converted.
  store.setState({
    repos: [{ ...repo, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: worktreeId, repoId: 'repo-1', path: '/root/repo', hostId: 'ssh:ssh-1' })
      ]
    },
    projectGroups: [{ ...group, connectionId: 'ssh-1' }],
    folderWorkspaces: [folder],
    runtimeEnvironments: [],
    startupWorktreeRefreshCompleted: false,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null
  })
})

describe('a host that just moved to its managed server', () => {
  it('pins existing desktop pages before refreshing their workspace ownership', async () => {
    const page = buildBrowserPage('browser', worktreeId, 'https://private.invalid/')
    store.setState({ browserPagesByWorkspace: { browser: [page] } })
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'managed',
      environmentId: 'env-browser'
    })

    expect(store.getState().browserPagesByWorkspace.browser?.[0]).toEqual({
      ...page,
      browserRuntimeEnvironmentId: null
    })
    await vi.waitFor(() =>
      expect(store.getState().repos.map((entry) => entry.executionHostId)).toEqual([
        'runtime:env-browser'
      ])
    )
    expect(
      store.getState().browserPagesByWorkspace.browser?.[0]?.browserRuntimeEnvironmentId
    ).toBeNull()
  })

  it('shows the server copies only, under the server name', async () => {
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'managed',
      environmentId: 'env-1'
    })

    await vi.waitFor(() =>
      expect(store.getState().repos.map((entry) => entry.executionHostId)).toEqual([
        'runtime:env-1'
      ])
    )
    const state = store.getState()
    expect(state.worktreesByRepo['repo-1']).toEqual([])
    expect(state.runtimeEnvironments.map((entry) => entry.name)).toEqual(['Box server'])
    expect(state.projectGroups.map((entry) => entry.executionHostId)).toEqual(['runtime:env-1'])
    expect(state.folderWorkspaces.map((entry) => entry.executionHostId)).toEqual(['runtime:env-1'])
  })

  it('moves the open workspace onto the server so its panes stop dialing the stopped relay', async () => {
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-1',
            path: '/root/repo',
            hostId: 'ssh:ssh-1'
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-1',
            path: '/root/repo',
            hostId: 'runtime:env-2'
          })
        ]
      },
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:ssh-1'
    })
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'managed',
      environmentId: 'env-2'
    })

    await vi.waitFor(() =>
      expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-2')
    )
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
  })

  it('leaves a workspace open on another host where it is', async () => {
    store.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:ssh-9'
    })
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'managed',
      environmentId: 'env-3'
    })
    await vi.waitFor(() =>
      expect(store.getState().repos.map((entry) => entry.executionHostId)).toEqual([
        'runtime:env-3'
      ])
    )
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('ssh:ssh-9')
  })

  it('loads once per server, not on every start or wake of it', async () => {
    const managed = { kind: 'managed', environmentId: 'env-1' } as const
    applySshManagedServerTransition('ssh-2', undefined, managed)
    applySshManagedServerTransition('ssh-2', managed, { kind: 'setting-up', phase: 'connecting' })
    applySshManagedServerTransition('ssh-2', { kind: 'setting-up', phase: 'connecting' }, managed)
    await vi.waitFor(() =>
      expect(store.getState().repos.map((entry) => entry.executionHostId)).toContain(
        'runtime:env-1'
      )
    )
    expect(window.api.runtimeEnvironments.list).toHaveBeenCalledTimes(1)
    expect(window.api.repos.list).toHaveBeenCalledTimes(1)
  })

  it.each(['repo.list', 'projectGroup.list', 'folderWorkspace.list'])(
    'keeps the relay rows and retries after a failed %s refresh',
    async (method) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let failed = false
      const call = vi.fn(async (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === method && !failed) {
          failed = true
          throw new Error('connection dropped during conversion catalog refresh')
        }
        return serverReply(args)
      })
      Object.assign(window.api.runtimeEnvironments, { call })
      const managed = { kind: 'managed', environmentId: 'env-1' } as const
      const targetId = `ssh-retry-${method}`
      store.setState({
        repos: [{ ...repo, connectionId: targetId, executionHostId: `ssh:${targetId}` }],
        worktreesByRepo: {
          'repo-1': [makeWorktree({ id: worktreeId, repoId: 'repo-1', hostId: `ssh:${targetId}` })]
        },
        projectGroups: [{ ...group, connectionId: targetId }]
      })
      applySshManagedServerTransition(targetId, undefined, managed)
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(store.getState().worktreesByRepo['repo-1']).toHaveLength(1)
      const callsBeforeReconnect = call.mock.calls.filter(([args]) => args.method === method).length
      applySshManagedServerTransition(targetId, managed, {
        kind: 'setting-up',
        phase: 'connecting'
      })
      applySshManagedServerTransition(
        targetId,
        { kind: 'setting-up', phase: 'connecting' },
        managed
      )
      await vi.waitFor(() =>
        expect(call.mock.calls.filter(([args]) => args.method === method).length).toBeGreaterThan(
          callsBeforeReconnect
        )
      )
      await vi.waitFor(() =>
        expect(store.getState().folderWorkspaces.map((entry) => entry.executionHostId)).toEqual([
          'runtime:env-1'
        ])
      )
      errorLog.mockRestore()
      warningLog.mockRestore()
    }
  )

  it('reloads the server names after a failed environment list on reconnect', async () => {
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const list = vi.mocked(window.api.runtimeEnvironments.list)
    list.mockRejectedValueOnce(new Error('environment catalog unavailable'))
    const managed = { kind: 'managed', environmentId: 'env-1' } as const
    applySshManagedServerTransition('ssh-list-retry', undefined, managed)
    await vi.waitFor(() => expect(warningLog).toHaveBeenCalled())
    applySshManagedServerTransition('ssh-list-retry', managed, {
      kind: 'setting-up',
      phase: 'connecting'
    })
    applySshManagedServerTransition('ssh-list-retry', undefined, managed)
    await vi.waitFor(() =>
      expect(store.getState().runtimeEnvironments.map((entry) => entry.name)).toEqual([
        'Box server'
      ])
    )
    expect(list).toHaveBeenCalledTimes(2)
    warningLog.mockRestore()
  })

  it('replays a reconnect that arrived while the failed catalog read was still pending', async () => {
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const targetId = 'ssh-overlap'
    const firstRead = Promise.withResolvers<never>()
    let repoListCalls = 0
    const call = vi.fn(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list' && ++repoListCalls === 1) {
        return firstRead.promise
      }
      return serverReply(args)
    })
    Object.assign(window.api.runtimeEnvironments, { call })
    store.setState({
      repos: [{ ...repo, connectionId: targetId, executionHostId: `ssh:${targetId}` }],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: worktreeId, repoId: 'repo-1', hostId: `ssh:${targetId}` }),
          makeWorktree({ id: worktreeId, repoId: 'repo-1', hostId: 'runtime:env-1' })
        ]
      },
      projectGroups: [{ ...group, connectionId: targetId }],
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: `ssh:${targetId}`
    })
    const managed = { kind: 'managed', environmentId: 'env-1' } as const
    const settingUp = { kind: 'setting-up', phase: 'connecting' } as const
    applySshManagedServerTransition(targetId, undefined, managed)
    await vi.waitFor(() => expect(repoListCalls).toBe(1))
    applySshManagedServerTransition(targetId, managed, settingUp)
    applySshManagedServerTransition(targetId, settingUp, managed)
    firstRead.reject(new Error('half-open connection timed out'))

    await vi.waitFor(() =>
      expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-1')
    )
    expect(repoListCalls).toBe(2)
    warningLog.mockRestore()
    errorLog.mockRestore()
  })

  it('drops a pending reconnect replay when the host returns to the relay', async () => {
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const firstList = Promise.withResolvers<never>()
    const list = vi.mocked(window.api.runtimeEnvironments.list)
    list.mockReturnValueOnce(firstList.promise)
    const managed = { kind: 'managed', environmentId: 'env-1' } as const
    const settingUp = { kind: 'setting-up', phase: 'connecting' } as const
    applySshManagedServerTransition('ssh-overlap-relay', undefined, managed)
    applySshManagedServerTransition('ssh-overlap-relay', managed, settingUp)
    applySshManagedServerTransition('ssh-overlap-relay', settingUp, managed)
    applySshManagedServerTransition('ssh-overlap-relay', managed, {
      kind: 'relay',
      reason: 'orcad_unavailable'
    })
    firstList.reject(new Error('environment catalog unavailable'))
    await vi.waitFor(() => expect(warningLog).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(1)
    warningLog.mockRestore()
  })

  it('abandons an in-flight conversion refresh when the host returns to the relay', async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof window.api.runtimeEnvironments.list>>>()
    vi.mocked(window.api.runtimeEnvironments.list).mockReturnValueOnce(pending.promise)
    const managed = { kind: 'managed', environmentId: 'env-1' } as const
    applySshManagedServerTransition('ssh-cancel-load', undefined, managed)
    applySshManagedServerTransition('ssh-cancel-load', managed, {
      kind: 'relay',
      reason: 'orcad_unavailable'
    })
    pending.resolve([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.api.repos.list).not.toHaveBeenCalled()
  })
})
