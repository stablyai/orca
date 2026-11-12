import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// JA-01 tail: Delete sandbox on a create stopped by its environment check must delete THAT sandbox
// (its runtime, hence its control-plane record), and the restart path must delete it before retrying.

const { state, gate, cleanup, retry } = vi.hoisted(() => {
  const entries: Record<string, Record<string, unknown>> = {}
  return {
    state: {
      entries,
      repos: [
        {
          id: 'repo-src',
          displayName: 'Hello-World',
          gitRemoteIdentity: { remoteUrl: 'https://github.com/octocat/Hello-World.git' }
        }
      ]
    },
    gate: vi.fn(),
    cleanup: vi.fn(async (_request: unknown, _actions?: unknown) => true),
    retry: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      pendingWorktreeCreations: state.entries,
      repos: state.repos,
      projects: [],
      activePendingCreationId: 'c1',
      updatePendingWorktreeCreation: (id: string, patch: Record<string, unknown>) => {
        if (state.entries[id]) {
          Object.assign(state.entries[id], patch)
        }
      },
      setRuntimeEnvironments: vi.fn(),
      setupProjectExistingFolder: vi.fn(),
      deleteProjectHostSetup: vi.fn()
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/runtime/ephemeral-vm/ephemeral-vm-environment-check', () => ({ gateVmCreateOnEnvironmentCheck: gate }))
vi.mock('@/runtime/ephemeral-vm/ephemeral-vm-failed-create-cleanup', () => ({
  cleanupFailedEphemeralVmWorkspace: cleanup
}))
vi.mock('@/runtime/ephemeral-vm/vm-create-hidden-checkouts', () => ({
  hideVmCreateCheckout: vi.fn(),
  settleVmCreateCheckoutAfterCleanup: vi.fn()
}))
vi.mock('@/lib/workspace/creation/worktree-creation-flow', () => ({
  retryBackgroundWorktreeCreation: retry
}))
vi.mock('@/runtime/ephemeral-vm/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: vi.fn(async () => ({
    ok: true,
    setup: {
      repo: { id: 'repo-vm', path: '/vercel/orca/workspaces/Hello-World/project' },
      setup: { id: 'setup-1', projectId: 'p1', hostId: 'runtime:env-1' }
    },
    runtimeId: 'rt-blocked',
    checkoutMode: 'provisioned-root',
    environmentId: 'env-1',
    stderr: '',
    warnings: []
  }))
}))

import { prepareRequestForCreate } from './workspace/creation/ephemeral-vm-worktree-creation'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only these fields.
const request = {
  name: 'elephantfish',
  setupDecision: 'inherit',
  ephemeralVmRecipe: {
    sourceRepoId: 'repo-src',
    recipeId: 'cloud',
    projectId: 'p1',
    checkoutMode: 'provisioned-root',
    provider: 'orca-cloud'
  }
} as unknown as WorktreeCreationRequest

describe('prepareRequestForCreate on a create stopped by its environment check', () => {
  beforeEach(() => {
    state.entries.c1 = { request }
    vi.stubGlobal('window', {
      api: { ephemeralVm: {}, runtimeEnvironments: { list: async () => [] } }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('Delete sandbox removes that very sandbox and creates nothing', async () => {
    gate.mockResolvedValue('stop')
    await expect(prepareRequestForCreate('c1', request)).resolves.toBeNull()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(cleanup.mock.calls[0][0]).toMatchObject({ ephemeralVmRuntimeId: 'rt-blocked' })
    expect(retry).not.toHaveBeenCalled()
  })

  it('Start again deletes the blocked sandbox before starting a new one', async () => {
    gate.mockResolvedValue('restart')
    await expect(prepareRequestForCreate('c1', request)).resolves.toBeNull()
    expect(cleanup.mock.calls[0][0]).toMatchObject({ ephemeralVmRuntimeId: 'rt-blocked' })
    expect(retry).toHaveBeenCalledWith('c1')
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(retry.mock.invocationCallOrder[0])
  })
})
