import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  buildHostIdByWorktreeId,
  buildWorkspaceSessionHostSnapshots,
  fetchWorkspaceSessionFromHosts,
  fetchWorkspaceSessionWithRuntimeHostOwners,
  patchWorkspaceSessionByHost,
  persistWorkspaceSessionByHost,
  persistWorkspaceSessionByHostSync,
  type HostPersistenceState
} from './workspace-session-host-persistence'

describe('fetchWorkspaceSessionFromHosts', () => {
  it('reads saved runtime host partitions before runtime repos are loaded', async () => {
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const localSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'local-wt'
    }
    const remoteSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: 'remote-tab',
            ptyId: null,
            worktreeId,
            title: 'Remote',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const get = vi.fn(async (hostId?: string) =>
      hostId === 'runtime:env-1' ? remoteSession : localSession
    )

    const session = await fetchWorkspaceSessionFromHosts({ get }, [], ['runtime:env-1'])

    expect(get).toHaveBeenCalledWith()
    expect(get).toHaveBeenCalledWith('runtime:env-1')
    expect(session.activeWorktreeId).toBe('local-wt')
    expect(session.tabsByWorktree[worktreeId]).toEqual(remoteSession.tabsByWorktree[worktreeId])
  })

  it('returns runtime owners for worktrees loaded from runtime host partitions', async () => {
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const get = vi.fn(async (hostId?: string): Promise<WorkspaceSessionState> => {
      if (hostId === 'runtime:env-1') {
        return {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: {
            [worktreeId]: [
              {
                id: 'remote-tab',
                ptyId: null,
                worktreeId,
                title: 'Remote',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          }
        }
      }
      return getDefaultWorkspaceSession()
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [], ['runtime:env-1'])

    expect(read.session.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(read.runtimeHostIdByWorkspaceSessionKey).toEqual({ [worktreeId]: 'runtime:env-1' })
  })

  it('normalizes canonical worktree session keys in runtime owner maps', async () => {
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const get = vi.fn(async (hostId?: string): Promise<WorkspaceSessionState> => {
      if (hostId === 'runtime:env-1') {
        return {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: {
            [workspaceKey]: [
              {
                id: 'remote-tab',
                ptyId: null,
                worktreeId,
                title: 'Remote',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          }
        }
      }
      return getDefaultWorkspaceSession()
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [], ['runtime:env-1'])

    expect(read.runtimeHostIdByWorkspaceSessionKey).toEqual({ [worktreeId]: 'runtime:env-1' })
  })

  it('returns runtime owners for folder workspace session keys', async () => {
    const folderKey = folderWorkspaceKey('folder-1')
    const get = vi.fn(async (hostId?: string): Promise<WorkspaceSessionState> => {
      if (hostId === 'runtime:env-1') {
        return {
          ...getDefaultWorkspaceSession(),
          activeWorkspaceKey: folderKey,
          tabsByWorktree: {
            [folderKey]: [
              {
                id: 'remote-folder-tab',
                ptyId: null,
                worktreeId: folderKey,
                title: 'Remote folder',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          }
        }
      }
      return getDefaultWorkspaceSession()
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [], ['runtime:env-1'])

    expect(read.session.tabsByWorktree[folderKey]).toHaveLength(1)
    expect(read.runtimeHostIdByWorkspaceSessionKey).toEqual({ [folderKey]: 'runtime:env-1' })
  })

  it('returns runtime owners for sleeping-agent-only runtime worktrees', async () => {
    const worktreeId = 'remote-repo::/srv/sleeping-wt'
    const get = vi.fn(async (hostId?: string): Promise<WorkspaceSessionState> => {
      if (hostId === 'runtime:env-1') {
        return {
          ...getDefaultWorkspaceSession(),
          sleepingAgentSessionsByPaneKey: {
            'remote-tab:leaf-1': {
              paneKey: 'remote-tab:leaf-1',
              tabId: 'remote-tab',
              worktreeId,
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'codex-session-1' },
              prompt: 'finish the task',
              state: 'working',
              capturedAt: 1,
              updatedAt: 1
            }
          }
        }
      }
      return getDefaultWorkspaceSession()
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [], ['runtime:env-1'])

    expect(read.session.sleepingAgentSessionsByPaneKey?.['remote-tab:leaf-1']?.worktreeId).toBe(
      worktreeId
    )
    expect(read.runtimeHostIdByWorkspaceSessionKey).toEqual({ [worktreeId]: 'runtime:env-1' })
  })

  it('routes restored runtime folder workspace patches back to the runtime host', async () => {
    const folderKey = folderWorkspaceKey('folder-1')
    const patch = vi.fn().mockResolvedValue(undefined)

    await patchWorkspaceSessionByHost(
      { get: vi.fn(), patch, setSync: vi.fn() },
      {
        tabsByWorktree: {
          [folderKey]: [
            {
              id: 'remote-folder-tab',
              ptyId: null,
              worktreeId: folderKey,
              title: 'Remote folder',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      {
        repos: [],
        worktreesByRepo: {},
        restoredRuntimeHostIdByWorkspaceSessionKey: { [folderKey]: 'runtime:env-1' }
      }
    )

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ tabsByWorktree: {} }))
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        tabsByWorktree: expect.objectContaining({
          [folderKey]: expect.any(Array)
        })
      }),
      'runtime:env-1'
    )
  })

  it('keeps catalog-known local folder workspace patches local over stale restored owners', async () => {
    const folderKey = folderWorkspaceKey('folder-1')
    const patch = vi.fn().mockResolvedValue(undefined)

    await patchWorkspaceSessionByHost(
      { get: vi.fn(), patch, setSync: vi.fn() },
      {
        tabsByWorktree: {
          [folderKey]: [
            {
              id: 'local-folder-tab',
              ptyId: null,
              worktreeId: folderKey,
              title: 'Local folder',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      {
        repos: [],
        folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group-1' }],
        projectGroups: [{ id: 'group-1', executionHostId: 'local' }],
        worktreesByRepo: {},
        restoredRuntimeHostIdByWorkspaceSessionKey: { [folderKey]: 'runtime:stale-env' }
      }
    )

    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        tabsByWorktree: expect.objectContaining({
          [folderKey]: expect.any(Array)
        })
      })
    )
    expect(patch.mock.calls[0][1]).toBeUndefined()
  })

  it('routes placeholder-owned runtime worktree patches back to the runtime host', async () => {
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const patch = vi.fn().mockResolvedValue(undefined)

    await patchWorkspaceSessionByHost(
      { get: vi.fn(), patch, setSync: vi.fn() },
      {
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'remote-tab',
              ptyId: null,
              worktreeId,
              title: 'Remote',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      {
        repos: [{ id: 'remote-repo', connectionId: null, executionHostId: 'runtime:env-1' }],
        worktreesByRepo: { 'remote-repo': [{ id: worktreeId, repoId: 'remote-repo' }] }
      }
    )

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ tabsByWorktree: {} }))
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        tabsByWorktree: expect.objectContaining({
          [worktreeId]: expect.any(Array)
        })
      }),
      'runtime:env-1'
    )
  })

  it('keeps same-id local repo worktrees in the local partition', async () => {
    const localWorktreeId = 'same-repo::/Users/me/project'
    const remoteWorktreeId = 'same-repo::/srv/project'
    const patch = vi.fn().mockResolvedValue(undefined)

    await patchWorkspaceSessionByHost(
      { get: vi.fn(), patch, setSync: vi.fn() },
      {
        tabsByWorktree: {
          [localWorktreeId]: [
            {
              id: 'local-tab',
              ptyId: null,
              worktreeId: localWorktreeId,
              title: 'Local',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ],
          [remoteWorktreeId]: [
            {
              id: 'remote-tab',
              ptyId: null,
              worktreeId: remoteWorktreeId,
              title: 'Remote',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      {
        repos: [
          { id: 'same-repo', connectionId: null, executionHostId: 'local' },
          { id: 'same-repo', connectionId: null, executionHostId: 'runtime:env-1' }
        ],
        worktreesByRepo: {
          'same-repo': [
            { id: localWorktreeId, repoId: 'same-repo' },
            { id: remoteWorktreeId, repoId: 'same-repo', hostId: 'runtime:env-1' }
          ]
        }
      }
    )

    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        tabsByWorktree: {
          [localWorktreeId]: expect.any(Array)
        }
      })
    )
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        tabsByWorktree: expect.objectContaining({
          [remoteWorktreeId]: expect.any(Array)
        })
      }),
      'runtime:env-1'
    )
  })

  it('defaults duplicate repo ids to local when the worktree has no host metadata', () => {
    const owner = buildHostIdByWorktreeId({
      repos: [
        { id: 'same-repo', connectionId: null, executionHostId: 'local' },
        { id: 'same-repo', connectionId: null, executionHostId: 'runtime:env-1' }
      ],
      worktreesByRepo: {
        'same-repo': [{ id: 'same-repo::/local-only', repoId: 'same-repo' }]
      }
    })

    expect(owner('same-repo::/local-only')).toBe('local')
  })

  it('routes canonical worktree keys using their raw worktree owner', () => {
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const owner = buildHostIdByWorktreeId({
      repos: [],
      worktreesByRepo: {
        'remote-repo': [{ id: worktreeId, repoId: 'remote-repo', hostId: 'runtime:env-1' }]
      }
    })

    expect(owner(worktreeWorkspaceKey(worktreeId))).toBe('runtime:env-1')
  })

  it('builds local-first host snapshots reused by synchronous persistence', () => {
    const localWorktreeId = 'local-repo::C:\\src\\local'
    const remoteWorktreeId = 'remote-repo::/srv/remote'
    const makeTab = (id: string, worktreeId: string) => ({
      id,
      ptyId: null,
      worktreeId,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const payload: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [localWorktreeId]: [makeTab('local-tab', localWorktreeId)],
        [remoteWorktreeId]: [makeTab('remote-tab', remoteWorktreeId)]
      }
    }
    const state = {
      repos: [
        { id: 'local-repo', connectionId: null, executionHostId: 'local' },
        { id: 'remote-repo', connectionId: null, executionHostId: 'runtime:env-1' }
      ],
      worktreesByRepo: {
        'local-repo': [{ id: localWorktreeId, repoId: 'local-repo' }],
        'remote-repo': [{ id: remoteWorktreeId, repoId: 'remote-repo', hostId: 'runtime:env-1' }]
      }
    } satisfies HostPersistenceState

    const snapshots = buildWorkspaceSessionHostSnapshots(payload, state)

    expect(snapshots.map((snapshot) => snapshot.hostId)).toEqual([undefined, 'runtime:env-1'])
    expect(snapshots[0].state.tabsByWorktree).toEqual({
      [localWorktreeId]: [expect.objectContaining({ id: 'local-tab' })]
    })
    expect(snapshots[1].state.tabsByWorktree).toEqual({
      [remoteWorktreeId]: [expect.objectContaining({ id: 'remote-tab' })]
    })

    const setSync = vi.fn()
    persistWorkspaceSessionByHostSync({ get: vi.fn(), patch: vi.fn(), setSync }, payload, state)

    expect(setSync.mock.calls).toEqual(
      snapshots.map((snapshot) => [snapshot.state, snapshot.hostId])
    )
  })
})

describe('persistWorkspaceSessionByHost', () => {
  it('awaits every host write before crossing the durable flush boundary', async () => {
    const localWorktreeId = 'local-repo::/src/local'
    const remoteWorktreeId = 'remote-repo::/srv/remote'
    const payload: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [localWorktreeId]: [
          {
            id: 'local-tab',
            ptyId: null,
            worktreeId: localWorktreeId,
            title: 'Local',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        [remoteWorktreeId]: [
          {
            id: 'remote-tab',
            ptyId: null,
            worktreeId: remoteWorktreeId,
            title: 'Remote',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const set = vi.fn().mockResolvedValue(undefined)
    const flush = vi.fn().mockResolvedValue(undefined)

    await persistWorkspaceSessionByHost(
      { get: vi.fn(), set, patch: vi.fn(), flush, setSync: vi.fn() },
      payload,
      {
        repos: [
          { id: 'local-repo', connectionId: null, executionHostId: 'local' },
          { id: 'remote-repo', connectionId: null, executionHostId: 'runtime:env-1' }
        ],
        worktreesByRepo: {
          'local-repo': [{ id: localWorktreeId, repoId: 'local-repo' }],
          'remote-repo': [{ id: remoteWorktreeId, repoId: 'remote-repo', hostId: 'runtime:env-1' }]
        }
      }
    )

    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ tabsByWorktree: { [localWorktreeId]: expect.any(Array) } })
    )
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        tabsByWorktree: { [remoteWorktreeId]: expect.any(Array) }
      }),
      'runtime:env-1'
    )
    expect(flush).toHaveBeenCalledTimes(1)
    expect(set.mock.invocationCallOrder.at(-1)).toBeLessThan(flush.mock.invocationCallOrder[0]!)
  })
})
