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
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

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

describe('moving one twin of a repo id on a paired server (server-local and server-SSH rows)', () => {
  it('names the twin by its server-side SSH target and updates only that row', async () => {
    const serverLocalTwin: Repo = { ...remoteRepo, connectionId: null, projectGroupId: null }
    const serverSshTwin: Repo = { ...remoteRepo, connectionId: 'srv-ssh', projectGroupId: null }
    runtimeMoveReturns({ ...serverSshTwin, projectGroupId: 'remote-group' })
    const store = createTestStore()
    store.setState({
      repos: [serverLocalTwin, serverSshTwin],
      projectGroups: [group('remote-group', REMOTE_HOST)]
    })

    await expect(store.getState().moveProjectToGroup(serverSshTwin, 'remote-group')).resolves.toBe(
      true
    )

    expect(moveCalls().map((request) => request.params)).toEqual([
      { repo: remoteRepo.id, groupId: 'remote-group', connectionId: 'srv-ssh' }
    ])
    expect(store.getState().repos.map((repo) => repo.projectGroupId ?? null)).toEqual([
      null,
      'remote-group'
    ])
  })
})

it('does not confirm null when an old owner returns an unchanged grouped row, and reports one generic transport failure', async () => {
  const store = createTestStore()
  store.setState({ repos: [remoteRepo], projectGroups: [group('remote-group', REMOTE_HOST)] })
  runtimeMoveReturns(remoteRepo)
  await expect(store.getState().moveProjectToGroup(remoteRepo, null)).resolves.toBe(false)
  expect(store.getState().repos[0]?.projectGroupId).toBe('remote-group')
  expect(toast.error).toHaveBeenCalledTimes(1)
  vi.mocked(toast.error).mockClear()
  runtimeCall.mockRejectedValueOnce(new Error('disconnected'))
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(store.getState().moveProjectToGroup(remoteRepo, null)).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not move project to group')
  } finally {
    quiet.mockRestore()
  }
})
