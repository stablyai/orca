import {
  registerEditorOwnerInterpretationContracts,
  runtimeEnvironment
} from './editor-file-operation-owner-interpretation.spec'
// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from './editor-file-operation-provenance'
import { getEditorFileOperationContext } from './editor-file-operation-owner'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const worktreeId = 'repo::/remote/repo'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
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
            targetGenerations: new Map(),
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
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            connectionId: null,
            folderPath: '/workspace/folder'
          } as never
        ],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
        restoredRuntimeHostIdByWorkspaceSessionKey: {}
      })
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

afterEach(() => vi.unstubAllGlobals())

registerEditorOwnerInterpretationContracts()
