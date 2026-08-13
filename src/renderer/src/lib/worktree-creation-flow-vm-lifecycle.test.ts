import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareTarget } = vi.hoisted(() => ({ prepareTarget: vi.fn() }))

const store = {
  settings: {},
  activeView: 'terminal',
  activePendingCreationId: null as string | null,
  repos: [{ id: 'repo-1', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  createWorktree: vi.fn(),
  setupProjectExistingFolder: vi.fn(),
  deleteProjectHostSetup: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'creation-1' }))
vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareTarget
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false),
  ensureWorktreeHasInitialTerminal: vi.fn(() => 'tab-1')
}))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

function request(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ephemeralVmRecipe: {
      sourceRepoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1'
    }
  }
}

function preparedTarget(): void {
  prepareTarget.mockResolvedValue({
    ok: true,
    runtimeId: 'runtime-1',
    environmentId: 'env-1',
    checkoutMode: 'orca-worktree',
    stderr: '',
    warnings: [],
    setup: {
      project: { id: 'project-1' },
      setup: { id: 'setup-1', projectId: 'project-1', hostId: 'runtime:env-1' },
      repo: { id: 'repo-runtime', path: '/workspace/repo' }
    }
  })
}

describe('worktree creation VM lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingWorktreeCreations = {}
    store.deleteProjectHostSetup.mockResolvedValue({})
    preparedTarget()
    globalThis.window = {
      api: {
        ephemeralVm: {
          attachWorkspace: vi.fn(),
          cleanup: vi.fn(),
          onProvisionEvent: vi.fn(() => vi.fn())
        }
      }
    } as never
  })

  it('cleans the runtime when workspace attachment fails', async () => {
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })
    vi.mocked(window.api.ephemeralVm.attachWorkspace).mockRejectedValue(new Error('attach failed'))

    runBackgroundWorktreeCreation(request())

    await vi.waitFor(() =>
      expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    )
    expect(store.deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1' })
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({ status: 'error' })
    )
  })

  it('does not attach a runtime after cancellation wins the create race', async () => {
    let finishCreate!: (value: unknown) => void
    store.createWorktree.mockReturnValue(new Promise((resolve) => (finishCreate = resolve)))
    runBackgroundWorktreeCreation(request())
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())

    delete store.pendingWorktreeCreations['creation-1']
    finishCreate({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    await vi.waitFor(() =>
      expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    )
    expect(window.api.ephemeralVm.attachWorkspace).not.toHaveBeenCalled()
    expect(store.deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1' })
  })
})
