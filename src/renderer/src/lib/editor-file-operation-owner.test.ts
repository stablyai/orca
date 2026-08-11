import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const worktreeId = 'repo::/remote/repo'

function runtimeEnvironment(id: string, pairingRevision: number) {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: id,
    preferredEndpointId: 'endpoint',
    endpoints: [{ id: 'endpoint', kind: 'websocket' as const, label: id, endpoint: 'ws://host' }]
  }
}

beforeEach(() => {
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set()
  })
})

describe('editor file operation owner', () => {
  it('round-trips the synthetic local owner for floating workspace files', () => {
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      FLOATING_TERMINAL_WORKTREE_ID,
      null,
      true
    )

    expect(
      getEditorFileOperationContext(
        useAppStore.getState(),
        {
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          runtimeEnvironmentId: null,
          operationProvenance: provenance
        },
        '/tmp/orca/floating-workspace'
      )
    ).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/tmp/orca/floating-workspace',
      expectedExecutionHostId: 'local'
    })
  })

  it('uses the explicit worktree owner instead of global runtime focus', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      }
    })

    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )
    const context = getEditorFileOperationContext(
      useAppStore.getState(),
      { worktreeId, operationProvenance: provenance },
      '/remote/repo'
    )

    expect(context.settings?.activeRuntimeEnvironmentId).toBe('hub-a')
  })

  it('rejects an open tab after the same environment id is re-paired', () => {
    useAppStore.getState().setRuntimeEnvironments([runtimeEnvironment('hub-a', 1)])
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      }
    })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )

    useAppStore.getState().setRuntimeEnvironments([runtimeEnvironment('hub-a', 2)])

    expect(() =>
      assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, provenance)
    ).toThrow('Reopen the file')
  })

  it('captures and rejects replacement nested SSH connection generations', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'ssh:private',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            targetsHydrated: true,
            targetLabels: new Map([['private', 'private']]),
            removedTargetLabels: new Map(),
            connectionStates: new Map([
              [
                'private',
                {
                  targetId: 'private',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 7
                }
              ]
            ])
          }
        ]
      ])
    })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )
    expect(provenance.expectedSshConnectionGeneration).toBe(7)

    useAppStore.setState((state) => ({
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            ...state.sshStateByEnvironment.get('hub-a')!,
            connectionStates: new Map([
              [
                'private',
                {
                  targetId: 'private',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 8
                }
              ]
            ])
          }
        ]
      ])
    }))

    expect(() =>
      assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, provenance)
    ).toThrow('Reopen the file')
  })

  it('rejects a restored external SSH file after its target changes', () => {
    useAppStore.setState({
      repos: [{ id: 'repo', connectionId: 'ssh-replacement' } as never],
      worktreesByRepo: {
        repo: [{ id: worktreeId, repoId: 'repo', path: '/remote/repo' } as never]
      },
      sshConnectionStates: new Map([
        [
          'ssh-replacement',
          {
            targetId: 'ssh-replacement',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 1
          }
        ]
      ])
    })

    expect(() =>
      getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId, externalSshTargetId: 'ssh-original' },
        '/remote/repo'
      )
    ).toThrow('Reopen the file')
  })

  describe('folder workspaces', () => {
    const folderWorkspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const folderKey = `folder:${folderWorkspaceId}`

    beforeEach(() => {
      useAppStore.setState({
        folderWorkspaces: [
          { id: folderWorkspaceId, projectGroupId: 'group-1', connectionId: null } as never
        ],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
        restoredRuntimeHostIdByWorkspaceSessionKey: {}
      })
    })

    it('round-trips capture and assert for a local folder workspace (#10251)', () => {
      const provenance = captureEditorFileOperationProvenance(
        useAppStore.getState(),
        folderKey,
        undefined,
        false
      )
      expect(provenance.generation.route).toEqual({
        executionHostId: 'local',
        runtimeEnvironmentId: null
      })
      expect(
        assertEditorFileOperationCurrent(useAppStore.getState(), folderKey, provenance)
      ).toEqual(provenance.generation.route)
    })

    it('uses the folder root when a legacy caller passes an empty worktree path', () => {
      useAppStore.setState({
        folderWorkspaces: [
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            connectionId: null,
            folderPath: '/workspace/folder'
          } as never
        ]
      })
      const context = getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId: folderKey },
        ''
      )

      expect(context.worktreePath).toBe('/workspace/folder')
    })

    it.each([['local-first' as const], ['ssh-first' as const]])(
      'uses the authorized folder root with %s catalog order',
      (order) => {
        const local = {
          id: folderWorkspaceId,
          projectGroupId: 'group-1',
          connectionId: null,
          executionHostId: 'local',
          folderPath: '/local/folder'
        } as never
        const ssh = {
          id: folderWorkspaceId,
          projectGroupId: 'group-1',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1',
          folderPath: '/remote/folder'
        } as never
        useAppStore.setState({
          activeWorktreeId: folderKey,
          activeWorkspaceExecutionHostId: 'local',
          folderWorkspaces: order === 'local-first' ? [local, ssh] : [ssh, local]
        })

        const context = getEditorFileOperationContext(
          useAppStore.getState(),
          { worktreeId: folderKey },
          ''
        )

        expect(context.expectedExecutionHostId).toBe('local')
        expect(context.worktreePath).toBe('/local/folder')
      }
    )

    it('uses the paired physical owner path through its runtime transport', () => {
      useAppStore.setState({
        activeWorktreeId: folderKey,
        activeWorkspaceExecutionHostId: 'ssh:builder',
        folderWorkspaces: [
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            folderPath: '/local/folder',
            executionHostId: 'runtime:hub-a',
            runtimeSourceExecutionHostId: 'local'
          } as never,
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            folderPath: '/remote/folder',
            executionHostId: 'runtime:hub-a',
            runtimeSourceExecutionHostId: 'ssh:builder',
            connectionId: 'builder'
          } as never
        ],
        projectGroups: [],
        sshStateByEnvironment: new Map([
          [
            'hub-a',
            {
              targetsHydrated: true,
              targetLabels: new Map([['builder', 'builder']]),
              removedTargetLabels: new Map(),
              connectionStates: new Map([
                [
                  'builder',
                  {
                    targetId: 'builder',
                    status: 'connected',
                    error: null,
                    reconnectAttempt: 0,
                    connectionGeneration: 7
                  }
                ]
              ])
            }
          ]
        ])
      })

      const context = getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId: folderKey },
        ''
      )

      expect(context).toMatchObject({
        worktreePath: '/remote/folder',
        expectedExecutionHostId: 'ssh:builder',
        expectedSshTargetId: 'builder',
        expectedSshConnectionGeneration: 7
      })
      expect(context.settings?.activeRuntimeEnvironmentId).toBe('hub-a')
    })

    it('fails closed when folder ownership changes between capture and assert', () => {
      useAppStore.setState({
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        folderWorkspaces: [{ id: folderWorkspaceId, projectGroupId: 'group-1' } as never]
      })
      const provenance = captureEditorFileOperationProvenance(
        useAppStore.getState(),
        folderKey,
        undefined,
        false
      )
      useAppStore.setState({
        projectGroups: [
          { id: 'group-1', connectionId: null, executionHostId: 'runtime:hub-a' } as never
        ]
      })
      expect(resolveWorktreeOperationRoute(useAppStore.getState(), folderKey)).toEqual({
        executionHostId: 'runtime:hub-a',
        runtimeEnvironmentId: 'hub-a'
      })
      expect(() =>
        assertEditorFileOperationCurrent(useAppStore.getState(), folderKey, provenance)
      ).toThrow('Reopen the file')
    })
  })
})
