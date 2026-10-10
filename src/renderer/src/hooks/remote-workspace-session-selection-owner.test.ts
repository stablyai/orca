import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import {
  mergeDirectSshRemoteWorkspaceSession,
  uniqueWorktreeIdByPath
} from './remote-workspace-session-merge'
import { createTestStore, makeWorktree, TEST_REPO } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from '../../../shared/remote-workspace-session-projection'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()

const WORKTREE = 'repo1::/workspace/selected'
const OTHER_WORKTREE = 'repo1::/workspace/other'
const OWNER: WorktreeSelectionOwner = {
  worktreeId: WORKTREE,
  publisherHostId: 'runtime:hub-a',
  executionHostId: 'ssh:private-a',
  instanceId: 'selected-instance'
}

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: OWNER.publisherHostId,
    activeWorkspaceOwner: OWNER,
    tabsByWorktree: { [WORKTREE]: [] },
    ...overrides
  }
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(current, remote, new Set([WORKTREE]), {}, new Set())
}

function importDirectSnapshotIntoSelection(
  owner: WorktreeSelectionOwner,
  environmentId: string | null
): ReturnType<typeof createTestStore> {
  const directRepo = {
    ...TEST_REPO,
    path: '/workspace/selected',
    connectionId: 'private-b',
    executionHostId: 'ssh:private-b' as const
  }
  const selectedRepo = repoWithFetchedOwner(
    {
      ...directRepo,
      executionHostId: owner.executionHostId,
      connectionId: owner.executionHostId === 'ssh:private-a' ? 'private-a' : 'private-b'
    },
    environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  )
  const selectedRow = withRepoHostOwnership(
    makeWorktree({
      id: WORKTREE,
      repoId: TEST_REPO.id,
      path: directRepo.path,
      hostId: owner.executionHostId,
      instanceId: owner.instanceId
    }),
    owner.publisherHostId
  )
  const directRow = makeWorktree({
    id: WORKTREE,
    repoId: TEST_REPO.id,
    path: directRepo.path,
    hostId: directRepo.executionHostId,
    instanceId: 'direct-instance'
  })
  const store = createTestStore()
  const sameDirectSource =
    owner.publisherHostId === 'local' && owner.executionHostId === directRepo.executionHostId
  store.setState({
    repos: sameDirectSource ? [directRepo] : [directRepo, selectedRepo],
    worktreesByRepo: { [TEST_REPO.id]: sameDirectSource ? [directRow] : [directRow, selectedRow] }
  })
  expect(store.getState().setActiveWorktree(WORKTREE, owner.executionHostId, { owner })).toBe(true)
  const replaceIds = new Set([WORKTREE])
  const wire = exportRemoteWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO.id,
      activeWorktreeId: WORKTREE,
      tabsByWorktree: { [WORKTREE]: [] }
    },
    { isTargetWorktree: (id) => replaceIds.has(id) }
  )
  expect('activeWorkspaceOwner' in wire).toBe(false)
  const incoming = importRemoteWorkspaceSession(wire, {
    resolveWorktreeId: uniqueWorktreeIdByPath(replaceIds),
    executionHostId: directRepo.executionHostId
  })
  expect(incoming.activeWorktreeId).toBe(WORKTREE)
  expect(incoming.activeWorkspaceOwner ?? null).toBeNull()
  const current = store.getState()
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(current),
    incoming,
    replaceIds,
    current.tabsByWorktree,
    new Set(),
    directRepo.executionHostId
  )
  store.getState().hydrateWorkspaceSession(merged, { replaceWorkspaceKeys: [...replaceIds] })
  return store
}

describe('remote workspace selection owner', () => {
  it.each(['hub-a', 'hub-b'])(
    'preserves %s ownership when a direct snapshot shares its workspace ID and raw SSH alias',
    (environmentId) => {
      const owner: WorktreeSelectionOwner = {
        ...OWNER,
        publisherHostId: `runtime:${environmentId}`,
        executionHostId: 'ssh:private-b'
      }

      const store = importDirectSnapshotIntoSelection(owner, environmentId)

      expect(store.getState().activeWorktreeId).toBe(WORKTREE)
      expect(store.getState().activeWorkspaceExecutionHostId).toBe(owner.executionHostId)
      expect(store.getState().activeWorkspaceOwner).toEqual(owner)
      expect(store.getState().getKnownWorktreeById(WORKTREE)?.runtimeOwnerEnvironmentId).toBe(
        environmentId
      )
    }
  )

  it('preserves a different raw host owned by the same local publisher', () => {
    const owner: WorktreeSelectionOwner = { ...OWNER, publisherHostId: 'local' }

    const store = importDirectSnapshotIntoSelection(owner, null)

    expect(store.getState().activeWorktreeId).toBe(WORKTREE)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(owner.executionHostId)
    expect(store.getState().activeWorkspaceOwner).toEqual(owner)
  })

  it('clears proof when a legacy snapshot selects the same direct-client source', () => {
    const owner: WorktreeSelectionOwner = {
      worktreeId: WORKTREE,
      publisherHostId: 'local',
      executionHostId: 'ssh:private-b',
      instanceId: 'direct-instance'
    }

    const store = importDirectSnapshotIntoSelection(owner, null)

    expect(store.getState().activeWorktreeId).toBe(WORKTREE)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(owner.executionHostId)
    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })

  it('preserves the current owner outside the remote target', () => {
    const owner = { ...OWNER, worktreeId: OTHER_WORKTREE }
    const current = session({ activeWorktreeId: OTHER_WORKTREE, activeWorkspaceOwner: owner })

    const result = merge(current, session({ activeWorkspaceOwner: null }))

    expect(result.activeWorktreeId).toBe(OTHER_WORKTREE)
    expect(result.activeWorkspaceOwner).toEqual(owner)
  })

  it('preserves the current owner when the remote host names no selected workspace', () => {
    const result = merge(session(), session({ activeWorktreeId: null, activeWorkspaceOwner: null }))

    expect(result.activeWorktreeId).toBe(WORKTREE)
    expect(result.activeWorkspaceOwner).toEqual(OWNER)
  })

  it('clears previous proof when an older peer supplies the winning selection', () => {
    const remote = session({ activeWorktreeId: OTHER_WORKTREE })
    delete remote.activeWorkspaceOwner

    const result = merge(session(), remote)

    expect(result.activeWorktreeId).toBe(OTHER_WORKTREE)
    expect(result.activeWorkspaceOwner).toBeNull()
  })

  it('carries the incoming owner with its matching selected workspace', () => {
    const owner = { ...OWNER, worktreeId: OTHER_WORKTREE, instanceId: 'other-instance' }

    const result = merge(
      session(),
      session({ activeWorktreeId: OTHER_WORKTREE, activeWorkspaceOwner: owner })
    )

    expect(result.activeWorkspaceOwner).toEqual(owner)
  })

  it('refuses incoming proof that disagrees with the retained host alias', () => {
    const result = merge(
      session(),
      session({
        activeWorkspaceOwner: {
          ...OWNER,
          publisherHostId: 'runtime:hub-b',
          executionHostId: 'ssh:private-b'
        }
      })
    )

    expect(result.activeWorkspaceExecutionHostId).toBe(OWNER.publisherHostId)
    expect(result.activeWorkspaceOwner).toBeNull()
  })

  it('refuses proof naming a different workspace than the winning selection', () => {
    const result = merge(session(), session({ activeWorktreeId: OTHER_WORKTREE }))

    expect(result.activeWorkspaceOwner).toBeNull()
  })
})
