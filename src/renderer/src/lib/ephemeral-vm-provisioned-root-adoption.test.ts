import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const { prepareTarget } = vi.hoisted(() => ({ prepareTarget: vi.fn() }))

const store = {
  fetchWorktrees: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(),
  setupProjectExistingFolder: vi.fn(),
  repos: [] as unknown[],
  pendingWorktreeCreations: {} as Record<string, unknown>,
  worktreesByRepo: {} as Record<string, never[]>,
  sortBy: 'recent' as const
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareTarget
}))

import {
  adoptEphemeralVmProvisionedRoot,
  prepareRequestForCreate
} from './ephemeral-vm-worktree-creation'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-runtime',
    name: 'feature',
    displayName: 'Feature workspace',
    baseBranch: 'origin/main',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-runtime',
      path: 'C:\\workspace\\repo'
    },
    ...overrides
  }
}

describe('provisioned-root adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.worktreesByRepo = {}
    store.repos = []
    store.pendingWorktreeCreations = { 'creation-1': {} }
    store.fetchWorktrees.mockImplementation(async () => {
      store.worktreesByRepo = {
        'repo-runtime': [
          {
            id: 'repo-runtime::C:\\workspace\\repo',
            repoId: 'repo-runtime',
            path: 'c:\\workspace\\repo\\',
            isMainWorktree: true
          }
        ] as never
      }
      return true
    })
    store.updateWorktreeMeta.mockResolvedValue({ ok: true })
    globalThis.window = {
      api: {
        ephemeralVm: {
          onProvisionEvent: vi.fn(() => vi.fn()),
          cleanup: vi.fn()
        }
      }
    } as never
  })

  it('adopts the exact main checkout and preserves creation metadata', async () => {
    const result = await adoptEphemeralVmProvisionedRoot(
      makeRequest({ linkedIssue: 13044, workspaceStatus: 'in-progress' })
    )

    expect(store.fetchWorktrees).toHaveBeenCalledWith('repo-runtime', {
      executionHostId: 'runtime:env-1',
      requireAuthoritative: true
    })
    expect(store.updateWorktreeMeta).toHaveBeenCalledWith(
      'repo-runtime::C:\\workspace\\repo',
      expect.objectContaining({
        displayName: 'Feature workspace',
        ephemeralVmCheckoutMode: 'provisioned-root',
        baseRef: 'origin/main',
        linkedIssue: 13044,
        workspaceStatus: 'in-progress'
      })
    )
    expect(result.worktree.path).toBe('c:\\workspace\\repo\\')
  })

  it('requests an authoritative scan for a runtime-owned SSH checkout', async () => {
    await adoptEphemeralVmProvisionedRoot(
      makeRequest({
        workspaceRunContext: {
          kind: 'workspace-run',
          projectId: 'project-1',
          hostId: 'ssh:runtime-ssh-vm-1',
          projectHostSetupId: 'setup-1',
          repoId: 'repo-runtime',
          path: 'C:\\workspace\\repo'
        }
      })
    )

    expect(store.fetchWorktrees).toHaveBeenCalledWith('repo-runtime', {
      executionHostId: 'ssh:runtime-ssh-vm-1',
      requireAuthoritative: true
    })
  })

  it('passes source intent to provisioning and keeps the adopted base ref', async () => {
    store.repos = [
      {
        id: 'source-repo',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/team/repo',
          remoteName: 'origin',
          remoteUrl: 'git@example.com:team/repo.git'
        }
      }
    ]
    prepareTarget.mockResolvedValue({
      ok: true,
      runtimeId: 'runtime-1',
      checkoutMode: 'provisioned-root',
      stderr: '',
      warnings: [],
      setup: {
        setup: { id: 'setup-1', projectId: 'project-1', hostId: 'runtime:env-1' },
        repo: { id: 'repo-runtime', path: '/workspace/repo' }
      }
    })
    const request = makeRequest({
      repoId: 'source-repo',
      branchNameOverride: 'review-branch',
      ephemeralVmRecipe: {
        sourceRepoId: 'source-repo',
        recipeId: 'cloud-sandbox',
        projectId: 'project-1',
        checkoutMode: 'provisioned-root'
      }
    })

    const prepared = await prepareRequestForCreate('creation-1', request)

    expect(prepareTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'git@example.com:team/repo.git',
        branch: 'review-branch',
        ref: 'origin/main'
      })
    )
    expect(prepared).toMatchObject({
      repoId: 'repo-runtime',
      baseBranch: 'origin/main',
      ephemeralVmCheckoutMode: 'provisioned-root'
    })
  })

  it('fails closed when projectRoot is not the authoritative main checkout', async () => {
    store.worktreesByRepo = {}
    store.fetchWorktrees.mockResolvedValue(false)
    await expect(adoptEphemeralVmProvisionedRoot(makeRequest())).rejects.toThrow(
      'Could not verify the recipe-provisioned Git checkout.'
    )

    store.fetchWorktrees.mockImplementation(async () => {
      store.worktreesByRepo = {
        'repo-runtime': [
          {
            id: 'repo-runtime::C:\\workspace\\other',
            repoId: 'repo-runtime',
            path: 'C:\\workspace\\other',
            isMainWorktree: true
          }
        ] as never
      }
      return true
    })
    await expect(adoptEphemeralVmProvisionedRoot(makeRequest())).rejects.toThrow(
      'projectRoot is not the imported Git checkout root'
    )
    expect(store.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects sparse checkout before provisioning', async () => {
    const result = await prepareRequestForCreate(
      'creation-1',
      makeRequest({
        sparseCheckout: { directories: ['src'] },
        ephemeralVmRecipe: {
          sourceRepoId: 'source-repo',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1',
          checkoutMode: 'provisioned-root'
        }
      })
    )

    expect(result).toBeNull()
    expect(prepareTarget).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: 'Provisioned-root recipes do not support sparse checkout.'
    })
  })
})
