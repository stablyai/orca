import { expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({
  refreshRuntimeEnvironmentStatus: vi.fn(),
  deleteProjectHostSetup: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ assertRuntimeEnvironmentCapability: vi.fn() }))
import { prepareEphemeralVmWorkspaceTarget } from './ephemeral-vm-workspace-target'
import {
  attachEphemeralVmRuntimeToWorkspace,
  cleanupEphemeralVmRuntimeForFailedCreate
} from './ephemeral-vm-worktree-creation'
it('keeps local Orca-server recipe attachment and cleanup on desktop owner, not guest', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  globalThis.window = {
    api: {
      ephemeralVm: {
        provision: vi.fn().mockResolvedValue({
          ok: true,
          connectionType: 'orca-server',
          stderr: '',
          warnings: [],
          environment: { id: 'guest-environment' },
          runtime: {
            id: 'desktop-owned-runtime',
            recipeResult: {
              schemaVersion: 1,
              pairingCode: 'orca://pair?code=test',
              projectRoot: '/workspace/repo'
            }
          }
        }),
        cleanup: vi.fn().mockResolvedValue({ ok: true }),
        attachWorkspace: vi.fn().mockResolvedValue(undefined)
      }
    }
  } as never
  const prepared = await prepareEphemeralVmWorkspaceTarget({
    repoId: 'desktop-repo',
    recipeId: 'local-recipe',
    projectId: 'project',
    workspaceName: 'workspace',
    setupExistingFolder: vi.fn().mockResolvedValue({
      project: { id: 'project' },
      setup: { id: 'setup', hostId: 'local' },
      repo: { id: 'guest-repo' }
    })
  })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  const request = {
    ephemeralVmRuntimeId: prepared.runtimeId,
    ephemeralVmRuntimeEnvironmentId: prepared.environmentId,
    ephemeralVmCheckoutMode: prepared.checkoutMode
  } as never
  await attachEphemeralVmRuntimeToWorkspace(request, 'workspace')
  await cleanupEphemeralVmRuntimeForFailedCreate(request)
  expect
    .soft(window.api.ephemeralVm.attachWorkspace)
    .toHaveBeenCalledWith({ runtimeId: 'desktop-owned-runtime', workspaceId: 'workspace' })
  expect
    .soft(window.api.ephemeralVm.cleanup)
    .toHaveBeenCalledWith({ runtimeId: 'desktop-owned-runtime' })
})
it('keeps an explicit central owner distinct from its SSH guest at registration and attachment', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  globalThis.window = {
    api: {
      ephemeralVm: {
        provision: vi.fn().mockResolvedValue({
          ok: true,
          connectionType: 'ssh',
          sshTargetId: 'central-ssh-guest',
          stderr: '',
          warnings: [],
          runtime: {
            id: 'central-owned-runtime',
            recipeResult: {
              schemaVersion: 1,
              connection: {
                type: 'ssh',
                projectRoot: '/workspace/repo',
                target: { host: '10.77.0.2', port: 22, username: 'agent' }
              }
            }
          }
        }),
        cleanup: vi.fn(),
        attachWorkspace: vi.fn().mockResolvedValue(undefined)
      }
    }
  } as never
  const setup = vi.fn().mockResolvedValue({
    project: { id: 'project' },
    setup: { id: 'setup', hostId: 'ssh:central-ssh-guest' },
    repo: { id: 'guest-repo' }
  })
  const prepared = await prepareEphemeralVmWorkspaceTarget({
    ownerEnvironmentId: 'central',
    repoId: 'central-repo',
    recipeId: 'vm',
    projectId: 'project',
    workspaceName: 'workspace',
    setupExistingFolder: setup
  })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) {
    return
  }
  expect(setup).toHaveBeenCalledWith({
    runtimeOwnerEnvironmentId: 'central',
    projectId: 'project',
    hostId: 'ssh:central-ssh-guest',
    path: '/workspace/repo',
    setupMethod: 'imported-existing-folder'
  })
  expect(prepared.ownerEnvironmentId).toBe('central')
  expect(prepared.environmentId).toBeUndefined()
  expect(prepared.setup.setup.hostId).toBe('runtime:central')
  await attachEphemeralVmRuntimeToWorkspace(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
    {
      ephemeralVmRuntimeId: prepared.runtimeId,
      ephemeralVmRuntimeEnvironmentId: prepared.environmentId,
      ephemeralVmCheckoutMode: prepared.checkoutMode,
      ephemeralVmRecipe: { ownerEnvironmentId: prepared.ownerEnvironmentId }
    } as never,
    'workspace'
  )
  expect(window.api.ephemeralVm.attachWorkspace).toHaveBeenCalledWith({
    runtimeId: 'central-owned-runtime',
    workspaceId: 'workspace',
    ownerEnvironmentId: 'central'
  })
})
