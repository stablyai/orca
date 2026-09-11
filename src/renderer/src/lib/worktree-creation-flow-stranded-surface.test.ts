import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'

// Guards executeWorktreeCreation's post-create tail: callers fire and forget,
// so a throw after createWorktree succeeds must be contained per-step and the
// creation must still reach completeWorktreeCreation, which tears the creation
// surface down. Also covers the caller-side .catch() backstop: a rejection that
// still escapes (e.g. pre-create preparation) becomes a visible error state
// plus toast instead of a panel silently stuck at "creating".

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

vi.mock('@/lib/worktree-creation-structured-recovery', () => ({
  markStructuredWorktreeLaunchUnconfirmed: vi.fn(),
  retryStructuredWorktreeLaunch: vi.fn()
}))

import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
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

function surfaceInput(activeView: TestActiveView): {
  activeView: TestActiveView
  activePendingCreationId: string | null
  hasActivePendingCreation: boolean
} {
  return {
    activeView,
    activePendingCreationId: store.activePendingCreationId,
    hasActivePendingCreation:
      store.activePendingCreationId !== null &&
      store.pendingWorktreeCreations[store.activePendingCreationId] !== undefined
  }
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
})

describe('a throw after createWorktree succeeds no longer strands the creation surface', () => {
  it('activating branch: a throw in activateAndRevealWorktree recovers a terminal and completes', async () => {
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('recovered-tab')
    vi.mocked(activateAndRevealWorktree).mockImplementation(() => {
      throw new Error('activation exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    expect(console.error).toHaveBeenCalledWith(
      'worktree create: activate-and-reveal failed',
      'wt-1',
      expect.any(Error)
    )
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      {}
    )
    // Contained: completion still tears the surface down.
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
    expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(store.activePendingCreationId).toBeNull()
    expect(shouldShowWorktreeCreationSurface(surfaceInput('terminal'))).toBe(false)
  })

  it('activating branch: leaves existing default tabs untouched after a partial failure', async () => {
    const request = makeRequest({ issueCommand: { command: 'echo setup' } })
    seedPendingCreation(request)
    store.tabsByWorktree = { 'wt-1': [{ id: 'existing-tab' }] }
    vi.mocked(activateAndRevealWorktree).mockImplementation(() => {
      throw new Error('reveal exploded after tab creation')
    })

    await executeWorktreeCreation('creation-1', request)

    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('activating branch: does not treat a default tab as the agent launch tab', async () => {
    const request = makeRequest({
      agent: 'codex',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })
    seedPendingCreation(request)
    store.tabsByWorktree = {
      'wt-1': [{ id: 'default-tab' }, { id: 'agent-tab', launchAgent: 'codex' }]
    }
    vi.mocked(activateAndRevealWorktree).mockImplementation(() => {
      throw new Error('reveal exploded after default tabs were created')
    })

    await executeWorktreeCreation('creation-1', request)

    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTabId: null })
    )
  })

  it('background branch: a throw in after-wake seeding is contained after tabs are seeded', async () => {
    // User left the terminal view mid-create, so the non-activating branch runs.
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
    vi.mocked(ensureWebRuntimeWorktreeTerminalAfterWake).mockImplementation(() => {
      throw new Error('after-wake exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    // Tabs were seeded for the new worktree...
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ activateCreatedTabs: false })
    )
    expect(console.error).toHaveBeenCalledWith(
      'worktree create: after-wake terminal seeding failed',
      'wt-1',
      expect.any(Error)
    )
    // ...and the creation still completed instead of stranding the entry.
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
    expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(store.activePendingCreationId).toBeNull()
    expect(shouldShowWorktreeCreationSurface(surfaceInput('terminal'))).toBe(false)
  })

  it('concurrent create: a throw completing a backgrounded creation still tears its entry down', async () => {
    // A second submitted create repointed activePendingCreationId, so this
    // creation's completion takes the non-activating branch on the terminal view.
    store.activeView = 'terminal'
    const request = makeRequest()
    seedPendingCreation(request)
    store.activePendingCreationId = 'creation-2'
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-1', repoId: 'repo-1' },
      setup: { runnerScriptPath: '/tmp/setup.sh' }
    })
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
    vi.mocked(ensureWebRuntimeWorktreeTerminalAfterWake).mockImplementation(() => {
      throw new Error('after-wake exploded')
    })

    await executeWorktreeCreation('creation-1', request)

    // Blank terminal + Setup tab are seeded by this one synchronous call.
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      store,
      'wt-1',
      undefined,
      { runnerScriptPath: '/tmp/setup.sh' },
      undefined,
      undefined,
      expect.objectContaining({ activateCreatedTabs: false })
    )
    // The entry is gone; the pointer stays on the other in-flight creation.
    expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(store.activePendingCreationId).toBe('creation-2')
    expect(shouldShowWorktreeCreationSurface(surfaceInput('terminal'))).toBe(false)
  })

  it('control: with no throw the same flow completes and tears the surface down', async () => {
    store.activeView = 'tasks'
    const request = makeRequest()
    seedPendingCreation(request)
    vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')

    await executeWorktreeCreation('creation-1', request)

    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
    expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(store.activePendingCreationId).toBeNull()
    expect(shouldShowWorktreeCreationSurface(surfaceInput('terminal'))).toBe(false)
  })

  it('backstop: a rejection that escapes the execute promise becomes a visible inline error', async () => {
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

  it('backstop: a rejection after leaving the panel is announced with a toast', async () => {
    store.activeView = 'tasks'
    vi.mocked(prepareRequestForCreate).mockRejectedValue(new Error('prepare exploded'))

    const creationId = runBackgroundWorktreeCreation(makeRequest())
    // The pending surface is revealed synchronously; move away before the
    // rejected preparation reaches the fire-and-forget backstop.
    store.activeView = 'tasks'

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('prepare exploded')
    })
    expect(store.pendingWorktreeCreations[creationId]).toMatchObject({ status: 'error' })
  })
})
