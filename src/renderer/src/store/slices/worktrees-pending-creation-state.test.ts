import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

function makePendingCreation(
  creationId: string,
  overrides: Partial<PendingWorktreeCreation> = {}
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'fetching',
    status: 'creating',
    startedAt: 1000,
    indeterminate: false,
    loaderVisible: false,
    request: {
      repoId: 'repo1',
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    },
    ...overrides
  }
}

describe('pending worktree creation state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('beginPendingWorktreeCreation registers the entry and makes it the active surface', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))

    expect(store.getState().pendingWorktreeCreations.c1).toBeDefined()
    expect(store.getState().activePendingCreationId).toBe('c1')
  })

  it('keeps source and run context on the retryable request', () => {
    const store = createTestStore()
    const entry = makePendingCreation('c1', {
      request: {
        repoId: 'repo-ssh',
        taskSourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          projectHostSetupId: 'setup-local',
          repoId: 'repo-local',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        },
        workspaceRunContext: {
          kind: 'workspace-run',
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:ssh-1',
          projectHostSetupId: 'setup-ssh',
          repoId: 'repo-ssh',
          path: '/home/orca/orca'
        },
        name: 'feature',
        setupDecision: 'inherit',
        agent: null,
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }
    })

    store.getState().beginPendingWorktreeCreation(entry)

    expect(store.getState().pendingWorktreeCreations.c1.request).toMatchObject({
      repoId: 'repo-ssh',
      taskSourceContext: {
        provider: 'github',
        hostId: 'local',
        repoId: 'repo-local'
      },
      workspaceRunContext: {
        hostId: 'ssh:ssh-1',
        projectHostSetupId: 'setup-ssh',
        repoId: 'repo-ssh'
      }
    })
  })

  it('updatePendingWorktreeCreation skips the write when the patch changes nothing', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))
    const before = store.getState().pendingWorktreeCreations

    store.getState().updatePendingWorktreeCreation('c1', { phase: 'fetching' })

    // Same map reference => no subscriber notification on a no-op progress event.
    expect(store.getState().pendingWorktreeCreations).toBe(before)
  })

  it('updatePendingWorktreeCreation applies a real phase change', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))

    store.getState().updatePendingWorktreeCreation('c1', { phase: 'creating' })

    expect(store.getState().pendingWorktreeCreations.c1.phase).toBe('creating')
  })

  it('updatePendingWorktreeCreation can replace the retryable request during preflight', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))

    store.getState().updatePendingWorktreeCreation('c1', {
      request: {
        ...store.getState().pendingWorktreeCreations.c1.request,
        setupDecision: 'run'
      }
    })

    expect(store.getState().pendingWorktreeCreations.c1.request.setupDecision).toBe('run')
  })

  it('updatePendingWorktreeCreation is a no-op for an unknown id', () => {
    const store = createTestStore()
    const before = store.getState().pendingWorktreeCreations

    store.getState().updatePendingWorktreeCreation('missing', { status: 'error', error: 'x' })

    expect(store.getState().pendingWorktreeCreations).toBe(before)
  })

  it('removePendingWorktreeCreation clears the active surface only when it points at the removed entry', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c2'))
    // c2 is active now; removing the background c1 must not steal the surface.
    store.getState().removePendingWorktreeCreation('c1')

    expect(store.getState().pendingWorktreeCreations.c1).toBeUndefined()
    expect(store.getState().activePendingCreationId).toBe('c2')

    store.getState().removePendingWorktreeCreation('c2')
    expect(store.getState().activePendingCreationId).toBeNull()
  })

  it('removePendingWorktreeCreation cancels active VM provisioning', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(
      makePendingCreation('c1', {
        phase: 'provisioning-vm'
      })
    )

    store.getState().removePendingWorktreeCreation('c1')

    expect(mockApi.ephemeralVm.cancelProvision).toHaveBeenCalledWith({ provisionId: 'c1' })
    expect(store.getState().pendingWorktreeCreations.c1).toBeUndefined()
  })

  it('removePendingWorktreeCreation cleans up a provisioned-root setup and VM runtime', async () => {
    const store = createTestStore()
    const deleteProjectHostSetup = vi.mocked(store.getState().deleteProjectHostSetup)
    deleteProjectHostSetup.mockResolvedValue({ setup: { id: 'setup-1' } } as never)
    store.getState().beginPendingWorktreeCreation(
      makePendingCreation('c1', {
        phase: 'fetching',
        request: {
          ...makePendingCreation('c1').request,
          ephemeralVmRuntimeId: 'runtime-1',
          ephemeralVmCheckoutMode: 'provisioned-root',
          workspaceRunContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'ssh:runtime-ssh-1',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/workspace/repo'
          }
        }
      })
    )

    store.getState().removePendingWorktreeCreation('c1')

    expect(deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1' })
    await vi.waitFor(() =>
      expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    )
    expect(store.getState().pendingWorktreeCreations.c1).toBeUndefined()
  })

  it('removePendingWorktreeCreation can drop a completed VM creation without cleanup', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(
      makePendingCreation('c1', {
        phase: 'fetching',
        request: {
          ...makePendingCreation('c1').request,
          ephemeralVmRuntimeId: 'runtime-1'
        }
      })
    )

    store.getState().removePendingWorktreeCreation('c1', { cleanupVm: false })

    expect(mockApi.ephemeralVm.cleanup).not.toHaveBeenCalled()
    expect(store.getState().pendingWorktreeCreations.c1).toBeUndefined()
  })

  it('setActivePendingWorktreeCreation ignores unknown ids but always accepts null', () => {
    const store = createTestStore()
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1'))

    store.getState().setActivePendingWorktreeCreation('missing')
    expect(store.getState().activePendingCreationId).toBe('c1')

    store.getState().setActivePendingWorktreeCreation(null)
    expect(store.getState().activePendingCreationId).toBeNull()
  })

  it('setActiveWorktree dismisses the creation panel even when re-selecting the already-active worktree', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/a', repoId: 'repo1' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id,
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: makePendingCreation('c1') }
    } as unknown as Partial<AppState>)

    store.getState().setActiveWorktree(wt.id)

    expect(store.getState().activePendingCreationId).toBeNull()
  })
})
