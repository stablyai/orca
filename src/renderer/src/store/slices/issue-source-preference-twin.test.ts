import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { buildTaskPageRepoSourceState } from '../../components/task-page-cache-selectors'
import { getTaskPageRepoCacheInput } from '../../components/task-page-source-context'

const localTwin: Repo = {
  id: 'twin',
  path: '/local/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const sshTwin: Repo = {
  ...localTwin,
  path: '/ssh/twin',
  addedAt: 2,
  connectionId: 'server',
  executionHostId: 'ssh:server'
}
const runtimeTwin: Repo = {
  ...localTwin,
  path: '/runtime/twin',
  addedAt: 3,
  executionHostId: 'runtime:env-1'
}

const reposUpdate = vi.fn()
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposUpdate.mockReset()
  reposUpdate.mockResolvedValue(undefined)
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { update: reposUpdate },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    }
  })
})

describe('issue-source preference on a repo id with a row on two hosts', () => {
  it('saves the SSH twin’s preference on its own row, leaving the local twin alone', async () => {
    const store = createTestStore()
    store.setState({ repos: [localTwin, sshTwin] })

    await store.getState().setIssueSourcePreference('twin', sshTwin.path, 'upstream', 'ssh:server')

    expect(reposUpdate).toHaveBeenCalledWith({
      repoId: 'twin',
      hostId: 'ssh:server',
      updates: { issueSourcePreference: 'upstream' }
    })
    expect(store.getState().repos).toEqual([
      localTwin,
      { ...sshTwin, issueSourcePreference: 'upstream' }
    ])
  })

  it('sends a paired-server twin’s preference to that server', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-update',
      ok: true,
      result: { repo: { ...runtimeTwin, issueSourcePreference: 'origin' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ repos: [localTwin, runtimeTwin] })

    await store
      .getState()
      .setIssueSourcePreference('twin', runtimeTwin.path, 'origin', 'runtime:env-1')

    expect(reposUpdate).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'repo.update',
        params: { repo: 'twin', updates: { issueSourcePreference: 'origin' } }
      })
    )
    expect(store.getState().repos[0]).toEqual(localTwin)
  })

  it('names each twin’s host in the Tasks source state, even when both rows share a path', () => {
    // Why no executionHostId: older SSH rows carry only connectionId.
    const { executionHostId: _local, ...unstampedLocal } = localTwin
    const samePathSsh: Repo = { ...unstampedLocal, addedAt: 2, connectionId: 'server' }
    const states = buildTaskPageRepoSourceState(
      [unstampedLocal, samePathSsh].map(getTaskPageRepoCacheInput),
      []
    )

    expect(states.map((s) => s.hostId)).toEqual(['local', 'ssh:server'])
  })
})
