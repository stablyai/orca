import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import {
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
import {
  captureDirectSshMutationExpectation,
  captureWorktreeSshMutationExpectation
} from './ssh-mutation-expectation'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from '@/components/right-sidebar/file-explorer-operation-owner'

const targetId = 'runtime-ssh-owned-fixture'
const hostId = `ssh:${targetId}` as const
const worktreeId = `${TEST_REPO.id}::/remote/recipe-fixture`
const generation = 9007199254000001

beforeEach(() => {
  useAppStore.setState(createTestStore().getState())
  useAppStore.setState({
    repos: [{ ...TEST_REPO, connectionId: targetId, executionHostId: hostId }],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id: worktreeId,
          repoId: TEST_REPO.id,
          path: '/remote/recipe-fixture',
          hostId
        })
      ]
    },
    runtimeOwnedSshConnectionGenerations: new Map([[targetId, generation]])
  })
})

it('captures the private host token when a Recipe VM editor file opens', () => {
  const provenance = captureEditorFileOperationProvenance(
    useAppStore.getState(),
    worktreeId,
    null,
    true
  )
  expect(provenance.expectedSshConnectionGeneration).toBe(generation)
  expect(
    getEditorFileOperationContext(
      useAppStore.getState(),
      { worktreeId, runtimeEnvironmentId: null, operationProvenance: provenance },
      '/remote/recipe-fixture'
    )
  ).toMatchObject({ connectionId: targetId, expectedSshConnectionGeneration: generation })
  expect(useAppStore.getState().sshConnectionStates.has(targetId)).toBe(false)
})

it('captures the same host token for an Explorer mutation', () => {
  const guard = captureFileExplorerOperationGuard(
    worktreeId,
    getFileExplorerOperationOwner(worktreeId)
  )
  expect(guard.assertCurrent()).toMatchObject({
    connectionId: targetId,
    expectedSshConnectionGeneration: generation
  })
})

it('captures direct SSH attachment mutation authority without a user host row', () => {
  expect(captureDirectSshMutationExpectation(useAppStore.getState(), targetId)).toEqual({
    expectedExecutionHostId: hostId,
    expectedSshTargetId: targetId,
    expectedSshConnectionGeneration: generation
  })
})

it('captures worktree mutation authority without a user host row', () => {
  expect(captureWorktreeSshMutationExpectation(useAppStore.getState(), worktreeId)).toEqual({
    expectedExecutionHostId: hostId,
    expectedSshTargetId: targetId,
    expectedSshConnectionGeneration: generation
  })
})

it('never borrows desktop authority for a target owned by a paired HUB', () => {
  expect(() =>
    captureDirectSshMutationExpectation(useAppStore.getState(), targetId, 'different-hub')
  ).toThrow("Couldn't verify the SSH connection")
})

it('rejects an opened editor and an Explorer guard after authority rotates or is removed', () => {
  const provenance = captureEditorFileOperationProvenance(
    useAppStore.getState(),
    worktreeId,
    null,
    true
  )
  const guard = captureFileExplorerOperationGuard(
    worktreeId,
    getFileExplorerOperationOwner(worktreeId)
  )
  useAppStore.setState({
    runtimeOwnedSshConnectionGenerations: new Map([[targetId, generation + 1]])
  })
  expect(() =>
    getEditorFileOperationContext(
      useAppStore.getState(),
      { worktreeId, runtimeEnvironmentId: null, operationProvenance: provenance },
      '/remote/recipe-fixture'
    )
  ).toThrow("Couldn't verify which host owns this file")
  expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns this workspace")
  useAppStore.setState({ runtimeOwnedSshConnectionGenerations: new Map() })
  expect(() => captureDirectSshMutationExpectation(useAppStore.getState(), targetId)).toThrow(
    "Couldn't verify the SSH connection"
  )
})
