import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { useAppStore } from '@/store'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
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

    expect(context.target).toEqual({ kind: 'environment', environmentId: 'hub-a' })
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

afterEach(() => vi.unstubAllGlobals())

describe('shared editor owner interpretation', () => {
  it.each([100, 1_000])('does not walk %i unrelated runtimes on legacy editor triggers', (size) => {
    let reads = 0
    const state = {
      ...useAppStore.getState(),
      repos: [{ ...TEST_REPO, id: 'repo' }],
      worktreesByRepo: { repo: [makeWorktree({ id: worktreeId, repoId: 'repo' })] },
      runtimeEnvironments: Array.from({ length: size }, (_, index) => ({
        ...runtimeEnvironment(`unrelated-${index}`, 1),
        get id() {
          reads += 1
          return `unrelated-${index}`
        }
      }))
    }
    const counts = { capture: 0, assert: 0, model: 0 }
    const route = { executionHostId: 'local', runtimeEnvironmentId: null }
    for (let index = 0; index < 20; index += 1) {
      const provenance = captureEditorFileOperationProvenance(state, worktreeId, null, true)
      expect(provenance.generation.route).toEqual(route)
      counts.capture += reads
      reads = 0
      expect(assertEditorFileOperationCurrent(state, worktreeId, provenance)).toEqual(route)
      counts.assert += reads
      reads = 0
      expect(resolveEditorModelOwner({ worktreeId }, state)).toEqual({
        environmentId: null,
        hostId: 'local'
      })
      counts.model += reads
      reads = 0
    }
    expect(counts).toEqual({ capture: 0, assert: 0, model: 0 })
    const provenance = captureEditorFileOperationProvenance(state, worktreeId, null, true)
    const removed = { ...state, repos: [], worktreesByRepo: {} }
    expect(() => assertEditorFileOperationCurrent(removed, worktreeId, provenance)).toThrow(
      'Reopen the file'
    )
    expect(() => captureEditorFileOperationProvenance(removed, worktreeId, null, true)).toThrow(
      'Reopen the file'
    )
  })

  it.each([100, 1_000])('skips %i unrelated catalog rows on folder editor triggers', (size) => {
    const counts = { worktree: 0, detected: 0, repo: 0 }
    function counted<T extends { id: string }>(row: T, kind: keyof typeof counts): T {
      return {
        ...row,
        get id() {
          counts[kind] += 1
          return row.id
        }
      }
    }
    const workspace = folderWorkspaceKey('docs')
    const base = {
      ...useAppStore.getState(),
      folderWorkspaces: [makeFolderWorkspace({ id: 'docs', executionHostId: 'local' })],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {}
    }
    const provenance = captureEditorFileOperationProvenance(base, workspace, undefined, false)
    for (let generation = 0; generation < 20; generation += 1) {
      const detected = makeDetectedResult(
        'unrelated',
        Array.from({ length: size }, (_, index) =>
          makeWorktree({ id: `detected-${index}`, repoId: 'unrelated' })
        )
      )
      const state = {
        ...base,
        worktreesByRepo: {
          unrelated: Array.from({ length: size }, (_, index) =>
            counted(makeWorktree({ id: `wt-${index}`, repoId: 'unrelated' }), 'worktree')
          )
        },
        detectedWorktreesByRepo: {
          unrelated: {
            ...detected,
            worktrees: detected.worktrees.map((row) => counted(row, 'detected'))
          }
        },
        repos: Array.from({ length: size }, (_, index) =>
          counted({ ...TEST_REPO, id: `repo-${index}` }, 'repo')
        )
      }
      // Model lookup runs first on cold catalog identities, then all three paths reuse them.
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(resolveEditorModelOwner({ worktreeId: workspace }, state)).toEqual({
          environmentId: null,
          hostId: 'local'
        })
        expect(
          captureEditorFileOperationProvenance(state, workspace, undefined, false).generation.route
        ).toEqual(provenance.generation.route)
        expect(assertEditorFileOperationCurrent(state, workspace, provenance)).toEqual(
          provenance.generation.route
        )
      }
    }
    expect(counts).toEqual({ worktree: 0, detected: 0, repo: 0 })
    const moved = {
      ...base,
      folderWorkspaces: [makeFolderWorkspace({ id: 'docs', executionHostId: 'runtime:hub-a' })]
    }
    expect(resolveEditorModelOwner({ worktreeId: workspace }, moved)).toEqual({
      environmentId: 'hub-a',
      hostId: 'runtime:hub-a'
    })
    for (const state of [moved, { ...base, folderWorkspaces: [] }]) {
      expect(() => assertEditorFileOperationCurrent(state, workspace, provenance)).toThrow(
        'Reopen the file'
      )
    }
  })

  it.each(['runtime:hub-a', 'ssh:private'] as const)(
    'keeps uncaptured models and operations on stamped paired owner %s',
    (hostId) => {
      vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            makeWorktree({
              id: worktreeId,
              repoId: 'repo',
              hostId,
              runtimeOwnerEnvironmentId: 'hub-a'
            })
          ]
        }
      })
      const state = useAppStore.getState()
      const provenance = captureEditorFileOperationProvenance(state, worktreeId, undefined, false)
      const route = assertEditorFileOperationCurrent(state, worktreeId, provenance)
      expect(resolveEditorModelOwner({ worktreeId }, state)).toEqual({
        environmentId: route.runtimeEnvironmentId,
        hostId: route.executionHostId
      })
      expect(route).toEqual({ executionHostId: hostId, runtimeEnvironmentId: 'hub-a' })
    }
  )

  it('qualifies a same-id folder at capture without letting later focus change model identity', () => {
    const workspace = folderWorkspaceKey('twin')
    useAppStore.setState({
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'twin', executionHostId: 'local' }),
        makeFolderWorkspace({ id: 'twin', executionHostId: 'runtime:hub-a' })
      ],
      activeWorktreeId: workspace,
      activeWorkspaceExecutionHostId: 'local'
    })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      workspace,
      undefined,
      false
    )
    for (const host of ['local', 'runtime:hub-a'] as const) {
      useAppStore.setState({ activeWorkspaceExecutionHostId: host })
      const state = useAppStore.getState()
      expect(resolveEditorModelOwner({ worktreeId: workspace }, state).hostId).toBeNull()
      expect(
        resolveEditorModelOwner({ worktreeId: workspace, operationProvenance: provenance }, state)
      ).toEqual({ environmentId: null, hostId: 'local' })
      expect(assertEditorFileOperationCurrent(state, workspace, provenance).executionHostId).toBe(
        'local'
      )
    }
  })

  it('retains captured model identity while refusing vanished or ambiguous mutation owners', () => {
    const owner = makeWorktree({ id: worktreeId, repoId: 'repo', hostId: 'local' })
    useAppStore.setState({ worktreesByRepo: { repo: [owner] } })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )
    for (const worktrees of [[], [owner, { ...owner, hostId: 'runtime:hub-a' as const }]]) {
      useAppStore.setState({ worktreesByRepo: { repo: worktrees } })
      const state = useAppStore.getState()
      expect(() => assertEditorFileOperationCurrent(state, worktreeId, provenance)).toThrow(
        'Reopen the file'
      )
      expect(
        resolveEditorModelOwner({ worktreeId, operationProvenance: provenance }, state).hostId
      ).toBe('local')
      expect(resolveEditorModelOwner({ worktreeId }, state).hostId).toBeNull()
    }
  })
})
