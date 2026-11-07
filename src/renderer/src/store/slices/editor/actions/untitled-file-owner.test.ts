import { makeDetectedResult } from '../../worktrees-detected-listing-fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUntitledFileInActiveWorkspace } from './untitled-file-creation'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from '../../store-test-helpers'
import { createStoreCascadesMockApi } from '../../store-cascades-test-harness'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const id = 'repo1::/workspace/twin'

function setup(activeHost: ExecutionHostId) {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: activeHost,
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', path: '/local/copy', hostId: 'local' }),
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/server/copy',
          hostId: 'runtime:peer',
          runtimeOwnerEnvironmentId: 'peer'
        })
      ]
    }
  })
  store.setState({ openFile: vi.fn(() => 'created-file') })
  return store
}

beforeEach(() => {
  createStoreCascadesMockApi()
})

describe('untitled files in a selected workspace copy', () => {
  it.each(['local', 'runtime:peer'] as const)(
    'creates on %s and retains its owner after selection changes',
    async (hostId) => {
      const store = setup(hostId === 'local' ? 'runtime:peer' : 'local')
      const created = await createUntitledFileInActiveWorkspace(
        store.getState,
        'target-group',
        async (context) => {
          expect(context.worktreePath).toBe(hostId === 'local' ? '/local/copy' : '/server/copy')
          expect(context.target).toEqual(
            hostId === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'peer' }
          )
          store.setState({ activeWorktreeId: 'elsewhere', activeWorkspaceExecutionHostId: 'local' })
          context.assertOperationCurrent()
          expect(
            assertEditorFileOperationCurrent(store.getState(), id, context.operationProvenance)
          ).toEqual(
            hostId === 'local'
              ? { executionHostId: 'local', runtimeEnvironmentId: null }
              : { executionHostId: 'runtime:peer', runtimeEnvironmentId: 'peer' }
          )
          return {
            filePath: `${context.worktreePath}/untitled.md`,
            relativePath: 'untitled.md',
            worktreeId: id,
            language: 'markdown',
            isUntitled: true,
            mode: 'edit',
            operationProvenance: context.operationProvenance
          }
        },
        'Creation failed',
        id,
        hostId
      )
      expect(created).toBe(true)
      expect(store.getState().openFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: hostId === 'local' ? '/local/copy/untitled.md' : '/server/copy/untitled.md'
        }),
        { preview: false, targetGroupId: 'target-group', focusEditor: true }
      )
    }
  )

  it('refuses a captured copy once it disappears instead of switching to its surviving twin', () => {
    const store = setup('local')
    const provenance = captureEditorFileOperationProvenance(
      store.getState(),
      id,
      undefined,
      false,
      'runtime:peer'
    )
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id, repoId: 'repo1', path: '/local/copy', hostId: 'local' })]
      }
    })
    expect(() => assertEditorFileOperationCurrent(store.getState(), id, provenance)).toThrow(
      'Reopen the file'
    )
  })
})

it.each(['local', 'runtime:peer'] as const)(
  'qualifies an unstamped detected row only on its catalog owner (%s)',
  async (host) => {
    const store = setup('local')
    seedStore(store, {
      repos: [{ ...TEST_REPO, id: 'repo1', executionHostId: host }],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [
          makeWorktree({ id, repoId: 'repo1', path: '/hidden/copy', hostId: undefined })
        ])
      }
    })
    const created = await createUntitledFileInActiveWorkspace(
      store.getState,
      'group',
      async (context) => {
        context.assertOperationCurrent()
        return {
          filePath: '/hidden/copy/untitled.md',
          relativePath: 'untitled.md',
          worktreeId: id,
          language: 'markdown',
          isUntitled: true,
          mode: 'edit',
          operationProvenance: context.operationProvenance
        }
      },
      'Creation failed',
      id,
      'local'
    )
    expect(created).toBe(host === 'local')
    if (host === 'local') {
      expect(store.getState().openFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/hidden/copy/untitled.md' }),
        expect.anything()
      )
    } else {
      expect(store.getState().openFile).not.toHaveBeenCalled()
    }
  }
)

it('creates a file through the runtime alias of a detected-only SSH worktree', async () => {
  const store = setup('local')
  seedStore(store, {
    repos: [{ ...TEST_REPO, id: 'repo1', executionHostId: 'runtime:peer' }],
    worktreesByRepo: {},
    sshStateByEnvironment: new Map([
      [
        'peer',
        {
          connectionStates: new Map([
            [
              'box',
              {
                targetId: 'box',
                status: 'connected',
                connectionGeneration: 1,
                error: null,
                reconnectAttempt: 0,
                remotePlatform: 'linux'
              }
            ]
          ]),
          targetLabels: new Map(),
          targetGenerations: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: true
        }
      ]
    ]),
    detectedWorktreesByRepo: {
      repo1: makeDetectedResult('repo1', [
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/server/ssh-copy',
          hostId: 'ssh:box',
          runtimeOwnerEnvironmentId: 'peer'
        })
      ])
    }
  })
  expect(store.getState().getKnownWorktreeById(id, 'runtime:peer')?.path).toBe('/server/ssh-copy')
  const created = await createUntitledFileInActiveWorkspace(
    store.getState,
    'group',
    async (context) => {
      context.assertOperationCurrent()
      expect(context).toMatchObject({
        target: { kind: 'environment', environmentId: 'peer' },
        expectedExecutionHostId: 'ssh:box',
        expectedSshTargetId: 'box',
        expectedSshConnectionGeneration: 1
      })
      return {
        filePath: '/server/ssh-copy/untitled.md',
        relativePath: 'untitled.md',
        worktreeId: id,
        language: 'markdown',
        isUntitled: true,
        mode: 'edit',
        operationProvenance: context.operationProvenance
      }
    },
    'Creation failed',
    id,
    'runtime:peer'
  )
  expect(created).toBe(true)
  expect(store.getState().openFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/server/ssh-copy/untitled.md' }),
    expect.anything()
  )
})
