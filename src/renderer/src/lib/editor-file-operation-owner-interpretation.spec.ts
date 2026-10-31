import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { makeFolderWorkspace } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from './editor-file-operation-owner'

const worktreeId = 'repo::/remote/repo'

export function runtimeEnvironment(id: string, pairingRevision: number) {
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

export function registerEditorOwnerInterpretationContracts(): void {
  describe('shared editor owner interpretation', () => {
    it.each([100, 1_000])(
      'does not walk %i unrelated runtimes on legacy editor triggers',
      (size) => {
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
      }
    )

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
            captureEditorFileOperationProvenance(state, workspace, undefined, false).generation
              .route
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
}
