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

  it('carries the host’s visit recency to the server instead of leaving it for the next prune', async () => {
    store.setState({
      lastVisitedAtByWorktreeId: { [`ssh:ssh-1|${worktreeId}`]: 500, [`local|${worktreeId}`]: 7 }
    })
    applySshManagedServerTransition('ssh-1', undefined, { kind: 'managed', environmentId: 'env-7' })

    await vi.waitFor(() =>
      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
        [`runtime:env-7|${worktreeId}`]: 500,
        [`local|${worktreeId}`]: 7
      })
    )
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

  it('moves the open workspace once the cold-start scan delivers the server rows', async () => {
    store.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:ssh-1'
    })
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'managed',
      environmentId: 'env-4'
    })
    await vi.waitFor(() => expect(store.getState().worktreesByRepo['repo-1']).toEqual([]))
    // Startup's own scan has not run yet, so the server's row is not known.
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('ssh:ssh-1')

    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-1',
            path: '/root/repo',
            hostId: 'runtime:env-4'
          })
        ]
      },
      startupWorktreeRefreshCompleted: true
    })

    expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-4')
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
  })

  describe('a project linked to the copy another desktop already put on the server', () => {
    const sourceRepo: Repo = { ...repo, id: 'repo-b', path: '/root/migrepo' }
    const sourceWorktreeId = 'repo-b::/root/migrepo'
    const serverWorktreeId = 'repo-a::/root/migrepo'
    const linked = [{ path: '/root/migrepo', automations: 0 }]

    beforeEach(() => {
      const call = vi.fn(async (args: RuntimeEnvironmentCallRequest) =>
        args.method === 'repo.list'
          ? {
              id: 'rpc',
              ok: true,
              result: { repos: [{ ...repo, id: 'repo-a', path: '/root/migrepo' }] },
              _meta: { runtimeId: 'orcad' }
            }
          : serverReply(args)
      )
      Object.assign(window.api.runtimeEnvironments, { call })
      store.setState({
        repos: [{ ...sourceRepo, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }],
        worktreesByRepo: {
          'repo-b': [
            makeWorktree({
              id: sourceWorktreeId,
              repoId: 'repo-b',
              path: '/root/migrepo',
              hostId: 'ssh:ssh-1'
            })
          ]
        },
        activeRepoId: 'repo-b',
        activeWorktreeId: sourceWorktreeId,
        activeWorkspaceExecutionHostId: 'ssh:ssh-1'
      })
    })

    const serverRows = (environmentId: string) => ({
      'repo-a': [
        makeWorktree({
          id: serverWorktreeId,
          repoId: 'repo-a',
          path: '/root/migrepo',
          hostId: `runtime:${environmentId}`
        })
      ]
    })

    it('moves the open workspace onto the server’s project, whose id differs', async () => {
      store.setState({
        worktreesByRepo: { ...store.getState().worktreesByRepo, ...serverRows('env-link') }
      })
      applySshManagedServerTransition('ssh-1', undefined, {
        kind: 'managed',
        environmentId: 'env-link',
        linked
      })

      await vi.waitFor(() =>
        expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-link')
      )
      expect(store.getState().activeWorktreeId).toBe(serverWorktreeId)
      expect(store.getState().activeRepoId).toBe('repo-a')
    })

    it('finds a checkout the server only detects, as its visibility settings hide it', async () => {
      applySshManagedServerTransition('ssh-1', undefined, {
        kind: 'managed',
        environmentId: 'env-link-hidden',
        linked
      })
      await vi.waitFor(() => expect(store.getState().worktreesByRepo['repo-b']).toEqual([]))

      store.setState({
        detectedWorktreesByRepo: {
          'repo-a': {
            repoId: 'repo-a',
            authoritative: true,
            source: 'git',
            worktrees: serverRows('env-link-hidden')['repo-a'].map((worktree) => ({
              ...worktree,
              ownership: 'external' as const,
              selectedCheckout: false,
              visible: false
            }))
          }
        },
        startupWorktreeRefreshCompleted: true
      })

      expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-link-hidden')
      expect(store.getState().activeWorktreeId).toBe(serverWorktreeId)
    })

    it('moves it once the cold-start scan delivers the server’s rows', async () => {
      applySshManagedServerTransition('ssh-1', undefined, {
        kind: 'managed',
        environmentId: 'env-link-cold',
        linked
      })
      await vi.waitFor(() => expect(store.getState().worktreesByRepo['repo-b']).toEqual([]))
      expect(store.getState().activeWorktreeId).toBe(sourceWorktreeId)

      store.setState({
        worktreesByRepo: serverRows('env-link-cold'),
        startupWorktreeRefreshCompleted: true
      })

      expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-link-cold')
      expect(store.getState().activeWorktreeId).toBe(serverWorktreeId)
    })

    it('keeps the selection while a failed scan leaves the server’s row unknown', async () => {
      applySshManagedServerTransition('ssh-1', undefined, {
        kind: 'managed',
        environmentId: 'env-link-failed-scan',
        linked
      })
      await vi.waitFor(() => expect(store.getState().worktreesByRepo['repo-b']).toEqual([]))
      // Startup's scan completed, but the server's listing failed and delivered no rows.
      store.setState({ startupWorktreeRefreshCompleted: true })
      expect(store.getState().activeWorktreeId).toBe(sourceWorktreeId)

      store.setState({ worktreesByRepo: serverRows('env-link-failed-scan') })

      expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-link-failed-scan')
      expect(store.getState().activeWorktreeId).toBe(serverWorktreeId)
    })

    it('selects nothing when the server has no copy to move to', async () => {
      applySshManagedServerTransition('ssh-1', undefined, {
        kind: 'managed',
        environmentId: 'env-unlinked'
      })
      await vi.waitFor(() => expect(store.getState().worktreesByRepo['repo-b']).toEqual([]))

      store.setState({
        worktreesByRepo: serverRows('env-unlinked'),
        startupWorktreeRefreshCompleted: true
      })

      expect(store.getState().activeWorktreeId).toBeNull()
      expect(store.getState().activeWorkspaceExecutionHostId).toBeNull()
      expect(store.getState().activeRepoId).toBeNull()
    })
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
