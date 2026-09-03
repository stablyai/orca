import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn(),
  launchStructuredWorktreeSession: vi.fn()
}))

const request: WorktreeCreationRequest = {
  repoId: 'repo-1',
  name: 'routing-recovery',
  setupDecision: 'run',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: 'Recover the route',
  quickTelemetry: null
}

const store = {
  activeView: 'terminal',
  activePendingCreationId: 'creation-1' as string | null,
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  repos: [],
  createWorktree: vi.fn(),
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
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: vi.fn(async () => request),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn()
}))

vi.mock('@/lib/provisioned-root-create-options', () => ({
  getProvisionedRootCreateOptions: vi.fn()
}))

vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))

vi.mock('@/lib/worktree-draft-startup-view-mode', () => ({
  resolveBackendDraftStartup: vi.fn()
}))

vi.mock('@/lib/worktree-creation-flow-startup', () => ({
  buildWorktreeCreationStartupOpt: vi.fn()
}))

vi.mock('@/lib/worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: mocks.launchStructuredWorktreeSession
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'

describe('structured worktree creation unknown outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingWorktreeCreations = {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'worktree-1', repoId: 'repo-1' }
    })
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    mocks.launchStructuredWorktreeSession.mockResolvedValue({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })
  })

  it('keeps the operation on its retry surface instead of reporting completion', async () => {
    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: 'Could not confirm whether Codex chat opened. Retry to check again.',
      structuredLaunchRecoveryWorktreeId: 'worktree-1'
    })
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('reconciles the created worktree on retry without creating another one', async () => {
    mocks.launchStructuredWorktreeSession
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: true,
        activation: false,
        primaryTabId: null
      })
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        activation: false,
        primaryTabId: null
      })

    await executeWorktreeCreation('creation-1', request)
    retryBackgroundWorktreeCreation('creation-1')

    await vi.waitFor(() => expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(2))
    expect(store.createWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        request,
        worktreeId: 'worktree-1',
        recoverUnknownLaunch: true
      })
    )
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })
})
