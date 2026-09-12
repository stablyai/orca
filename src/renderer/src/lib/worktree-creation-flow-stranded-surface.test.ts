import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'

// Guards the settlement contract of executeWorktreeCreation's post-create tail. Callers fire
// and forget, and completeWorktreeCreation is the only thing that removes the pending entry,
// so a throw once createWorktree has resolved must still complete — otherwise the creation
// surface stays mounted over a finished workspace and the user sees no tabs. The tail settles
// on a returned outcome, so the two non-completing outcomes (a cancelled create, an
// unconfirmed structured launch) must survive unchanged: both deliberately keep or drop the
// entry themselves, and a blanket `finally { completeWorktreeCreation() }` would destroy the
// retry affordance the unconfirmed case depends on. Also covers the caller-side .catch()
// backstop for failures BEFORE createWorktree resolves, which really are create failures.

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [] as { id: string; connectionId: string | null }[],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  // Mirrors pending-worktree-creation.ts: drop the entry and the active pointer.
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
    if (store.activePendingCreationId === creationId) {
      store.activePendingCreationId = null
    }
  }),
  setActivePendingWorktreeCreation: vi.fn((creationId: string | null) => {
    store.activePendingCreationId = creationId
  }),
  setActiveView: vi.fn((view: TestActiveView) => {
    store.activeView = view
  }),
  setSidebarOpen: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  createWorktree: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))

vi.mock('@/lib/worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: vi.fn(
    async (_creationId: string, request: WorktreeCreationRequest) => request
  ),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(async () => undefined),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn(async () => undefined)
}))

import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/worktree-creation-agent-seeds'
import { prepareRequestForCreate } from '@/lib/ephemeral-vm-worktree-creation'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
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
    ...overrides
  } as WorktreeCreationRequest
}

function makeStructuredRequest(): WorktreeCreationRequest {
  return makeRequest({ agent: 'codex', agentLaunchRoute: 'structured-native-chat' })
}

function seedPendingCreation(request: WorktreeCreationRequest): void {
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'fetching',
      status: 'creating',
      startedAt: 1,
      indeterminate: false,
      loaderVisible: true,
      request
    }
  }
  store.activePendingCreationId = 'creation-1'
}

function isCreationSurfaceShown(): boolean {
  return shouldShowWorktreeCreationSurface({
    activeView: 'terminal',
    activePendingCreationId: store.activePendingCreationId,
    hasActivePendingCreation:
      store.activePendingCreationId !== null &&
      store.pendingWorktreeCreations[store.activePendingCreationId] !== undefined
  })
}

function expectSettledAndRevealed(): void {
  expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
    cleanupVm: false
  })
  expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
  expect(store.activePendingCreationId).toBeNull()
  // The workbench is mounted behind the creation panel; dropping the entry is what
  // lets its tab chrome render.
  expect(isCreationSurfaceShown()).toBe(false)
}

beforeEach(() => {
  // resetAllMocks: implementations from prior tests (the injected throws) must not leak.
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  store.activeView = 'terminal'
  store.repos = [{ id: 'repo-1', connectionId: null }]
  store.tabsByWorktree = {}
  store.pendingWorktreeCreations = {}
  store.activePendingCreationId = null
  store.createWorktree.mockResolvedValue({
    worktree: { id: 'wt-1', repoId: 'repo-1' }
  })
  vi.mocked(launchStructuredWorktreeSession).mockResolvedValue({
    accepted: true,
    cancelled: false,
    visibilityUnknown: false,
    activation: false,
    primaryTabId: null
  })
})

describe('a throw in the post-create tail still completes the creation', () => {
  it('activating branch: a throw in activateAndRevealWorktree completes and reveals the workspace', async () => {
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(activateAndRevealWorktree).mockImplementation(() => {
      throw new Error('activation exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    expectSettledAndRevealed()
  })

  it('background branch: a throw in the initial terminal seed completes and reveals the workspace', async () => {
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockImplementation(() => {
      throw new Error('seeding exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    expectSettledAndRevealed()
  })

  it('background branch: a throw in after-wake seeding completes and reveals the workspace', async () => {
    // User left the terminal view mid-create, so the non-activating branch runs.
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
    vi.mocked(ensureWebRuntimeWorktreeTerminalAfterWake).mockImplementation(() => {
      throw new Error('after-wake exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalled()
    expectSettledAndRevealed()
  })

  it('structured branch: a throw in the structured launch completes and reveals the workspace', async () => {
    const request = makeStructuredRequest()
    seedPendingCreation(request)
    vi.mocked(launchStructuredWorktreeSession).mockRejectedValue(new Error('launch exploded'))

    await executeWorktreeCreation('creation-1', request)

    expectSettledAndRevealed()
  })

  // Why: settlement reports what already landed, so a later failure does not discard the tab
  // the earlier step seeded — agent startup would otherwise be delivered to no pane.
  it('keeps the tab a completed step already seeded when a later step throws', async () => {
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
    vi.mocked(ensureWebRuntimeWorktreeTerminalAfterWake).mockImplementation(() => {
      throw new Error('after-wake exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    expect(seedAgentTabStateAfterWorktreeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTabId: 'tab-1' })
    )
  })

  it('control: with no throw the same flow completes and reveals the workspace', async () => {
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')

    await executeWorktreeCreation('creation-1', request)

    expectSettledAndRevealed()
  })
})

describe('the two non-completing outcomes survive the throw guard', () => {
  // A blanket `finally { completeWorktreeCreation() }` would re-seed tabs and steal focus for
  // a workspace the user is already tearing down.
  it('cancelled: settles nothing, because the cancel path already removed the entry', async () => {
    const request = makeStructuredRequest()
    seedPendingCreation(request)
    vi.mocked(launchStructuredWorktreeSession).mockImplementation(async () => {
      store.removePendingWorktreeCreation('creation-1')
      return {
        accepted: true,
        cancelled: true,
        visibilityUnknown: false,
        activation: false as const,
        primaryTabId: null
      }
    })

    await executeWorktreeCreation('creation-1', request)

    expect(seedAgentTabStateAfterWorktreeCreate).not.toHaveBeenCalled()
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
  })

  // A blanket finally would drop the entry and with it structuredLaunchRecoveryWorktreeId,
  // which is the only handle the panel's retry has on the unconfirmed session.
  it('awaiting-visibility: keeps the entry on an error surface so retry stays reachable', async () => {
    const request = makeStructuredRequest()
    seedPendingCreation(request)
    vi.mocked(launchStructuredWorktreeSession).mockResolvedValue({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })

    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: 'Could not confirm whether Codex chat opened. Retry to check again.',
      structuredLaunchRecoveryWorktreeId: 'wt-1'
    })
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    // The surface legitimately persists here: it is the retry affordance, not a strand.
    expect(isCreationSurfaceShown()).toBe(true)
  })
})

describe('a failure before createWorktree resolves is still reported as a create failure', () => {
  it('becomes a visible inline error while the panel is showing it', async () => {
    // Pre-create preparation runs before the in-function try/catch.
    vi.mocked(prepareRequestForCreate).mockRejectedValue(new Error('prepare exploded'))

    const creationId = runBackgroundWorktreeCreation(makeRequest())

    await vi.waitFor(() => {
      expect(store.pendingWorktreeCreations[creationId]).toMatchObject({
        status: 'error',
        error: 'prepare exploded'
      })
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      'worktree create: unhandled failure',
      creationId,
      expect.any(Error)
    )
  })

  it('is announced with a toast once the user has left the panel', async () => {
    store.activeView = 'tasks'
    vi.mocked(prepareRequestForCreate).mockRejectedValue(new Error('prepare exploded'))

    const creationId = runBackgroundWorktreeCreation(makeRequest())
    // The pending surface is revealed synchronously; move away before the rejected
    // preparation reaches the fire-and-forget backstop.
    store.activeView = 'tasks'

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('prepare exploded')
    })
    expect(store.pendingWorktreeCreations[creationId]).toMatchObject({ status: 'error' })
  })
})
