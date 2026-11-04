import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import '../../components/task-page/task-page-cache-selectors'
import '../../components/task-page/task-page-source-context'

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
})
