import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareEphemeralVmWorkspaceTarget } from './ephemeral-vm-workspace-target'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'

function makeProvisionedRuntime(projectRoot: string) {
  return {
    ok: true as const,
    connectionType: 'orca-server' as const,
    stderr: 'creating sandbox',
    warnings: [],
    environment: {
      id: 'env-1',
      name: 'Repo VM',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
      preferredEndpointId: 'ws-env-1'
    },
    runtime: {
      id: 'runtime-1',
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      runtimeEnvironmentId: 'env-1',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1 as const,
        pairingCode: 'orca://pair?code=test',
        projectRoot
      }
    }
  }
}

describe('prepareEphemeralVmWorkspaceTarget failure paths', () => {
  const provision = vi.fn()
  const cleanup = vi.fn()
  const runtimeEnvironmentCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    provision.mockReset()
    cleanup.mockReset()
    runtimeEnvironmentCall.mockReset()
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: { provision, cleanup },
        runtimeEnvironments: { call: runtimeEnvironmentCall }
      }
    })
  })

  it('cleans up when the recipe-created pairing endpoint is unreachable', async () => {
    provision.mockResolvedValue(makeProvisionedRuntime('/workspace/repo'))
    runtimeEnvironmentCall.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6767'))
    const setupExistingFolder = vi.fn()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'status.get',
      timeoutMs: undefined
    })
    expect(setupExistingFolder).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'connect ECONNREFUSED 127.0.0.1:6767',
      stderr: 'creating sandbox'
    })
  })

  it('cleans up when the paired runtime rejects the returned projectRoot', async () => {
    provision.mockResolvedValue(makeProvisionedRuntime('/workspace/not-a-repo'))
    runtimeEnvironmentCall.mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-1'))
    const setupExistingFolder = vi.fn(async () => {
      throw new Error('Not a valid git repository: /workspace/not-a-repo')
    })

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(setupExistingFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      path: '/workspace/not-a-repo',
      setupMethod: 'imported-existing-folder'
    })
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'Not a valid git repository: /workspace/not-a-repo',
      stderr: 'creating sandbox'
    })
  })
})
