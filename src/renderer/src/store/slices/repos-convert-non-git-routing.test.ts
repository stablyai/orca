import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentTransportCall = vi.fn()
const convertRemoteToGit = vi.fn()

function runtimeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: 'Converted',
    badgeColor: '#111',
    addedAt: 1,
    kind: 'git'
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentTransportCall.mockReset()
  convertRemoteToGit.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { convertRemoteToGit },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('non-Git folder conversion routing', () => {
  it('stays on the runtime that inspected the folder after focus changes', async () => {
    const converted = runtimeRepo('repo-1', '/srv/non-git')
    runtimeEnvironmentTransportCall.mockImplementation(
      (request: RuntimeEnvironmentCallRequest & { selector?: string; params?: unknown }) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(
          request,
          `runtime-${request.selector}`
        )
        if (status) {
          return status
        }
        if (request.method === 'repo.convertToGit') {
          return {
            id: 'convert',
            ok: true,
            result: { repo: converted },
            _meta: { runtimeId: `runtime-${request.selector}` }
          }
        }
        throw new Error(`Unexpected runtime method ${request.method}`)
      }
    )
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-2' } as never
    })

    await expect(
      store.getState().convertNonGitFolderToGit({
        path: '/srv/non-git',
        runtimeEnvironmentId: 'env-1'
      })
    ).resolves.toEqual({ ...converted, executionHostId: 'runtime:env-1' })

    expect(runtimeEnvironmentTransportCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'repo.convertToGit',
        params: { path: '/srv/non-git' },
        timeoutMs: 60_000
      })
    )
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-2',
        method: 'repo.convertToGit'
      })
    )
  })

  it('upserts only the selected SSH host when repo IDs collide', async () => {
    const localRepo: Repo = {
      ...runtimeRepo('shared-repo', '/local/non-git'),
      displayName: 'Local project',
      executionHostId: 'local'
    }
    const sshFolder: Repo = {
      ...runtimeRepo('shared-repo', '/srv/non-git'),
      displayName: 'SSH folder',
      kind: 'folder',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
    const convertedSsh: Repo = {
      ...sshFolder,
      displayName: 'SSH project',
      kind: 'git'
    }
    convertRemoteToGit.mockResolvedValue({ repo: convertedSsh })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-2' } as never,
      repos: [localRepo, sshFolder]
    })

    await expect(
      store.getState().convertNonGitFolderToGit({
        path: '/srv/non-git',
        connectionId: 'ssh-1',
        runtimeEnvironmentId: null
      })
    ).resolves.toEqual(convertedSsh)

    expect(convertRemoteToGit).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      remotePath: '/srv/non-git'
    })
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([localRepo, convertedSsh])
  })
})
