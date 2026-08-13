import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from '@/components/right-sidebar/file-explorer-operation-owner'
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

    it('fails closed when folder ownership changes between capture and assert', () => {
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
      expect(() =>
        assertEditorFileOperationCurrent(useAppStore.getState(), folderKey, provenance)
      ).toThrow('Reopen the file')
    })
  })
})

// #11762: a per-workspace environment recipe with connection.type "ssh" registers a runtime-owned
// target (`runtime-ssh-<runtimeId>`) that main deliberately keeps out of ssh:state-changed, so its
// write-authorization generation arrives on a dedicated channel instead.
describe('runtime-owned SSH host (per-workspace environment)', () => {
  const recipeWorktreeId = 'recipe-repo::/workspace/repo'
  const runtimeOwnedTargetId = 'runtime-ssh-vm-1'

  beforeEach(() => {
    useAppStore.setState({
      repos: [
        {
          id: 'recipe-repo',
          connectionId: runtimeOwnedTargetId,
          executionHostId: `ssh:${runtimeOwnedTargetId}`
        } as never
      ],
      worktreesByRepo: {
        'recipe-repo': [
          {
            id: recipeWorktreeId,
            repoId: 'recipe-repo',
            path: '/workspace/repo',
            hostId: `ssh:${runtimeOwnedTargetId}`
          } as never
        ]
      },
      settings: { activeRuntimeEnvironmentId: null } as never,
      sshConnectionStates: new Map(),
      runtimeOwnedSshConnectionGenerations: new Map([[runtimeOwnedTargetId, 7]])
    })
  })

  it('authorizes a save with the published runtime-owned generation', () => {
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      recipeWorktreeId,
      undefined,
      false
    )

    expect(
      getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId: recipeWorktreeId, operationProvenance: provenance },
        '/workspace/repo'
      )
    ).toMatchObject({
      expectedExecutionHostId: `ssh:${runtimeOwnedTargetId}`,
      connectionId: runtimeOwnedTargetId,
      expectedSshTargetId: runtimeOwnedTargetId,
      expectedSshConnectionGeneration: 7
    })
  })

  it('authorizes file-tree mutations in the same workspace', () => {
    const owner = getFileExplorerOperationOwner(recipeWorktreeId)
    expect(owner).toEqual({ kind: 'ssh', connectionId: runtimeOwnedTargetId })

    expect(captureFileExplorerOperationGuard(recipeWorktreeId, owner).route).toMatchObject({
      expectedExecutionHostId: `ssh:${runtimeOwnedTargetId}`,
      expectedSshTargetId: runtimeOwnedTargetId,
      expectedSshConnectionGeneration: 7
    })
  })

  it('still fails closed while the authority is unknown', () => {
    useAppStore.setState({ runtimeOwnedSshConnectionGenerations: new Map() })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      recipeWorktreeId,
      undefined,
      false
    )

    expect(() =>
      getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId: recipeWorktreeId, operationProvenance: provenance },
        '/workspace/repo'
      )
    ).toThrow('Reopen the file')
    expect(() =>
      captureFileExplorerOperationGuard(
        recipeWorktreeId,
        getFileExplorerOperationOwner(recipeWorktreeId)
      )
    ).toThrow("Couldn't determine which host owns this workspace")
  })

  it('fails closed when the relay rotates between capture and assert', () => {
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      recipeWorktreeId,
      undefined,
      false
    )
    useAppStore.setState({
      runtimeOwnedSshConnectionGenerations: new Map([[runtimeOwnedTargetId, 8]])
    })

    expect(() =>
      assertEditorFileOperationCurrent(useAppStore.getState(), recipeWorktreeId, provenance)
    ).toThrow('Reopen the file')
  })

  it('never lends the local authority to the same target reached through a HUB', () => {
    useAppStore.setState({
      worktreesByRepo: {
        'recipe-repo': [
          {
            id: recipeWorktreeId,
            repoId: 'recipe-repo',
            path: '/workspace/repo',
            hostId: `ssh:${runtimeOwnedTargetId}`,
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      runtimeEnvironments: [runtimeEnvironment('hub-a', 1)] as never
    })
    const contextForHub = () =>
      getEditorFileOperationContext(
        useAppStore.getState(),
        {
          worktreeId: recipeWorktreeId,
          runtimeEnvironmentId: 'hub-a',
          operationProvenance: captureEditorFileOperationProvenance(
            useAppStore.getState(),
            recipeWorktreeId,
            'hub-a',
            true
          )
        },
        '/workspace/repo'
      )

    expect(contextForHub).toThrow('Reopen the file')

    // The route is genuinely HUB-scoped, so only the HUB's own publication may authorize it.
    useAppStore.setState({
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            connectionStates: new Map([
              [runtimeOwnedTargetId, { connectionGeneration: 5 } as never]
            ]),
            targets: [],
            targetLabels: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ]) as never
    })

    expect(contextForHub()).toMatchObject({ expectedSshConnectionGeneration: 5 })
  })
})
