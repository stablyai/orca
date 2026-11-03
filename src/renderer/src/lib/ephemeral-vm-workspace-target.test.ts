import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareEphemeralVmWorkspaceTarget,
  type PrepareEphemeralVmWorkspaceTargetArgs
} from './ephemeral-vm-workspace-target'
import type { ProjectHostSetupResult } from '../../../shared/project-types'

vi.mock('@/runtime/runtime-rpc-client', () => ({ assertRuntimeEnvironmentCapability: vi.fn() }))

import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

describe('prepareEphemeralVmWorkspaceTarget', () => {
  beforeEach(() => {
    globalThis.window = {
      api: {
        ephemeralVm: {
          provision: vi.fn(),
          cleanup: vi.fn()
        }
      }
    } as never
    vi.clearAllMocks()
    vi.mocked(assertRuntimeEnvironmentCapability).mockResolvedValue(undefined)
  })

  it("imports a provisioned root on the managed server that runs the VM's SSH host", async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'ssh',
      stderr: '',
      warnings: [],
      sshTargetId: 'runtime-ssh-runtime-1',
      environmentId: 'env-vm',
      expectedRefHead: 'abc123',
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-runtime-1',
        runtimeEnvironmentId: 'env-vm',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          connection: {
            type: 'ssh',
            projectRoot: '/workspace/repo',
            target: { label: 'Sandbox', host: 'sandbox.example.com', port: 22, username: 'root' }
          }
        }
      }
    })
    const setupResult = {
      project: { id: 'project-1' },
      setup: { id: 'setup-1', hostId: 'local' },
      repo: { id: 'repo-runtime' }
    } as ProjectHostSetupResult
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => setupResult
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-vm',
      'worktree.provisioned-root.v1',
      expect.any(String)
    )
    expect(setupExistingFolder).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'runtime:env-vm', path: '/workspace/repo' })
    )
    expect(result).toMatchObject({
      ok: true,
      setup: { setup: { hostId: 'runtime:env-vm' } },
      checkoutMode: 'provisioned-root',
      environmentId: 'env-vm',
      expectedRefHead: 'abc123'
    })
  })

  it('rejects and cleans up an Orca-server provisioned root before project import', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
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
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder = vi.fn()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Provisioned-root recipes currently require a direct SSH connection.'
    })
    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(setupExistingFolder).not.toHaveBeenCalled()
  })

  it('cleans up the runtime when required project setup capability is missing', async () => {
    vi.mocked(assertRuntimeEnvironmentCapability).mockRejectedValue(
      new Error('The recipe-created Orca server does not support project setup.')
    )
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
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
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder =
      vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'project-host-setup.v1',
      'The recipe-created Orca server does not support project setup.'
    )
    expect(setupExistingFolder).not.toHaveBeenCalled()
    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'The recipe-created Orca server does not support project setup.',
      stderr: 'creating sandbox'
    })
  })

  it('cleans up the runtime when importing the project root fails', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
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
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => null
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'Failed to register the recipe-created project root on the runtime.',
      stderr: 'creating sandbox'
    })
  })
})
