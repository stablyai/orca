/**
 * #13699: a project can only join a group in its own host's catalog. The host stores any other
 * group id as "no group" and still returns the row, so the move used to look successful.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const REMOTE_HOST: ExecutionHostId = 'runtime:env-b'

const remoteRepo: Repo = {
  id: 'remote-only',
  path: '/srv/remote-only',
  displayName: 'remote-only',
  badgeColor: '#111',
  addedAt: 1,
  executionHostId: REMOTE_HOST,
  projectGroupId: 'remote-group'
}

function group(id: string, executionHostId: ExecutionHostId): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const moveProject = vi.fn()
const runtimeCall = vi.fn<(request: RuntimeEnvironmentCallRequest) => Promise<unknown>>()

function runtimeMoveReturns(repo: Repo): void {
  runtimeCall.mockResolvedValue({
    id: 'rpc-move',
    ok: true,
    result: { repo },
    _meta: { runtimeId: 'runtime-b' }
  })
}

function moveCalls(): RuntimeEnvironmentCallRequest[] {
  return runtimeCall.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === 'projectGroup.moveProject')
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(toast.error).mockReset()
  moveProject.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      projectGroups: { moveProject },
      runtimeEnvironments: {
        call: (request: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(request) ?? runtimeCall(request)
      }
    }
  })
})

function storeWith(projectGroups: ProjectGroup[]) {
  const store = createTestStore()
  store.setState({ repos: [remoteRepo], projectGroups })
  return store
}

describe('moving a project into a group on another host', () => {
  it('refuses with a toast instead of sending a move that would ungroup the project', async () => {
    const store = storeWith([group('local-group', 'local'), group('remote-group', REMOTE_HOST)])

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, 'local-group', 0, REMOTE_HOST)
    ).resolves.toBe(false)

    expect(moveCalls()).toEqual([])
    expect(moveProject).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([remoteRepo])
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('still moves into a group on the project host when another host has a same-id copy', async () => {
    runtimeMoveReturns({ ...remoteRepo, projectGroupId: 'shared' })
    const store = storeWith([group('shared', 'local'), group('shared', REMOTE_HOST)])

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, 'shared', undefined, REMOTE_HOST)
    ).resolves.toBe(true)

    expect(moveCalls()).toHaveLength(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports failure when the host answers with the group cleared', async () => {
    runtimeMoveReturns({ ...remoteRepo, projectGroupId: null })
    // The group is not in this window's catalog yet, so only the host's answer can tell.
    const store = storeWith([])

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, 'unknown-group', undefined, REMOTE_HOST)
    ).resolves.toBe(false)

    expect(moveCalls()).toHaveLength(1)
    expect(store.getState().repos[0]?.projectGroupId).toBeNull()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('keeps removing a project from its group a success', async () => {
    runtimeMoveReturns({ ...remoteRepo, projectGroupId: null })
    const store = storeWith([group('remote-group', REMOTE_HOST)])

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, null, undefined, REMOTE_HOST)
    ).resolves.toBe(true)

    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('moving one twin of a repo id shared by a local and an SSH row', () => {
  it('names the SSH twin host to the local IPC, so main moves that row', async () => {
    const localTwin: Repo = { ...remoteRepo, executionHostId: 'local', path: '/laptop/dup' }
    const sshTwin: Repo = { ...remoteRepo, executionHostId: undefined, connectionId: 'ssh-1' }
    moveProject.mockResolvedValue({ ...sshTwin, projectGroupId: 'ssh-group' })
    const store = createTestStore()
    store.setState({
      repos: [localTwin, sshTwin],
      projectGroups: [group('ssh-group', 'ssh:ssh-1')]
    })

    await store.getState().moveProjectToGroup(remoteRepo.id, 'ssh-group', undefined, 'ssh:ssh-1')

    expect(moveProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: remoteRepo.id, hostId: 'ssh:ssh-1' })
    )
  })
})
