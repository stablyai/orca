import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'

const { prepareTarget, getSshState } = vi.hoisted(() => ({
  prepareTarget: vi.fn(),
  getSshState: vi.fn()
}))

const store = {
  fetchWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(),
  setupProjectExistingFolder: vi.fn(),
  deleteProjectHostSetup: vi.fn(),
  repos: [] as unknown[],
  pendingWorktreeCreations: {} as Record<string, unknown>,
  worktreesByRepo: {} as Record<string, never[]>,
  sshConnectionStates: new Map<string, SshConnectionState>(),
  setSshConnectionState: vi.fn((targetId: string, state: SshConnectionState) => {
    store.sshConnectionStates.set(targetId, state)
  }),
  clearSshConnectionState: vi.fn((targetId: string) => {
    store.sshConnectionStates.delete(targetId)
  }),
  sortBy: 'recent' as const
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareTarget
}))

import {
  adoptEphemeralVmProvisionedRoot,
  cleanupEphemeralVmRuntimeForFailedCreate,
  prepareRequestForCreate
} from './ephemeral-vm-worktree-creation'

function makeConnectedRuntimeSshState(
  overrides: Partial<SshConnectionState> = {}
): SshConnectionState {
  return {
    targetId: 'runtime-ssh-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
    connectionGeneration: 1,
    ...overrides
  }
}

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
function makeRuntimeSshRequest(
  overrides: Partial<WorktreeCreationRequest> = {}
): WorktreeCreationRequest {
  return makeRequest({
    ...overrides,
    workspaceRunContext: {
      ...makeRequest().workspaceRunContext!,
      hostId: 'ssh:runtime-ssh-1',
      path: '/work/notion-next',
      ...overrides.workspaceRunContext
    }
  })
}

describe('provisioned-root adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSshState.mockReset()
    store.worktreesByRepo = {}
    store.repos = []
    store.sshConnectionStates = new Map()
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
        },
        ssh: {
          getState: getSshState
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
  it('hydrates runtime SSH authority before adopting the exact main checkout', async () => {
    const sshState = makeConnectedRuntimeSshState()
    const callOrder: string[] = []
    store.repos = [
      {
        id: 'repo-runtime',
        path: '/work/notion-next',
        connectionId: 'runtime-ssh-1',
        executionHostId: 'ssh:runtime-ssh-1'
      }
    ]
    getSshState.mockImplementation(async () => {
      callOrder.push('getState')
      return sshState
    })
    store.fetchWorktrees.mockImplementationOnce(async () => {
      callOrder.push('fetchWorktrees')
      store.worktreesByRepo = {
        'repo-runtime': [
          {
            id: 'repo-runtime::/work/notion-next',
            repoId: 'repo-runtime',
            path: '/work/notion-next',
            isMainWorktree: true
          },
          {
            id: 'repo-runtime::/work/notion-next/child',
            repoId: 'repo-runtime',
            path: '/work/notion-next/child',
            isMainWorktree: false
          }
        ] as never
      }
      return true
    })

    const result = await adoptEphemeralVmProvisionedRoot(
      makeRuntimeSshRequest({ linkedIssue: 13044, workspaceStatus: 'in-progress' })
    )

    expect(callOrder).toEqual(['getState', 'fetchWorktrees'])
    expect(getSshState).toHaveBeenCalledWith({ targetId: 'runtime-ssh-1' })
    expect(store.fetchWorktrees).toHaveBeenCalledWith('repo-runtime', {
      executionHostId: 'ssh:runtime-ssh-1',
      requireAuthoritative: true
    })
    expect(store.sshConnectionStates.get('runtime-ssh-1')).toEqual(sshState)
    expect(store.updateWorktreeMeta).toHaveBeenCalledWith(
      'repo-runtime::/work/notion-next',
      expect.objectContaining({
        displayName: 'Feature workspace',
        ephemeralVmCheckoutMode: 'provisioned-root',
        baseRef: 'origin/main',
        linkedIssue: 13044,
        workspaceStatus: 'in-progress'
      })
    )
    expect(result.worktree).toMatchObject({
      id: 'repo-runtime::/work/notion-next',
      path: '/work/notion-next',
      isMainWorktree: true
    })
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(store.setupProjectExistingFolder).not.toHaveBeenCalled()
  })

  it.each([
    ['missing authority', null],
    ['temporary authority', makeConnectedRuntimeSshState({ status: 'reconnecting' })],
    [
      'partial authority',
      makeConnectedRuntimeSshState({ providerEpoch: null, connectionGeneration: undefined })
    ]
  ])('fails closed for %s', async (_label, authority) => {
    store.repos = [
      {
        id: 'repo-runtime',
        path: '/work/notion-next',
        connectionId: 'runtime-ssh-1',
        executionHostId: 'ssh:runtime-ssh-1'
      }
    ]
    getSshState.mockResolvedValue(authority)

    await expect(adoptEphemeralVmProvisionedRoot(makeRuntimeSshRequest())).rejects.toThrow(
      'Could not verify the recipe-provisioned Git checkout.'
    )

    expect(getSshState).toHaveBeenCalledWith({ targetId: 'runtime-ssh-1' })
    expect(store.fetchWorktrees).not.toHaveBeenCalled()
    expect(store.updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.createWorktree).not.toHaveBeenCalled()
  })

  it('fails closed when authority lookup rejects and cleanup removes the runtime state', async () => {
    const request = makeRuntimeSshRequest({ ephemeralVmRuntimeId: 'runtime-1' })
    request.workspaceRunContext = {
      ...request.workspaceRunContext!,
      projectHostSetupId: ''
    }
    store.sshConnectionStates.set('runtime-ssh-1', makeConnectedRuntimeSshState())
    getSshState.mockRejectedValue(new Error('temporary SSH state failure'))

    await expect(adoptEphemeralVmProvisionedRoot(request)).rejects.toThrow(
      'Could not verify the recipe-provisioned Git checkout.'
    )
    expect(store.fetchWorktrees).not.toHaveBeenCalled()
    expect(store.updateWorktreeMeta).not.toHaveBeenCalled()

    await cleanupEphemeralVmRuntimeForFailedCreate(request)

    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(store.clearSshConnectionState).toHaveBeenCalledWith('runtime-ssh-1')
    expect(store.sshConnectionStates.has('runtime-ssh-1')).toBe(false)
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
