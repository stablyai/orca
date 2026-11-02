import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture mutates this setting across test cases.
    nativeChatProviders: { claude: false, codex: false } as Record<string, boolean>
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [{ id: 'repo-runtime', connectionId: null }],
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
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {})),
  setupProjectExistingFolder: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import {
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from './worktree-creation-flow'

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.settings.nativeChatProviders = { claude: false, codex: false }
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
})

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
  }
}

function makePendingCreation(request: WorktreeCreationRequest): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request
  }
}

async function flushAsyncWorktreeCreation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('runBackgroundWorktreeCreation', () => {
  beforeEach(() => {
    store.settings.activeRuntimeEnvironmentId = null
    store.repos = [{ id: 'repo-runtime', connectionId: null }]
    store.pendingWorktreeCreations = {}
    store.activePendingCreationId = null
    store.beginPendingWorktreeCreation.mockClear()
    store.updatePendingWorktreeCreation.mockClear()
    store.removePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()
    store.createWorktree.mockReset().mockImplementation(() => new Promise(() => {}))
    store.setupProjectExistingFolder.mockReset()
    store.refreshRuntimeEnvironmentStatus.mockReset()
    prepareEphemeralVmWorkspaceTargetMock.mockReset()
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

  it('shows a VM provisioning phase and creates the worktree on the prepared runtime repo', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      } as never
    ]
    prepareEphemeralVmWorkspaceTargetMock.mockResolvedValue({
      ok: true,
      runtimeId: 'runtime-1',
      environmentId: 'env-1',
      stderr: '',
      warnings: [],
      setup: {
        project: { id: 'project-1' },
        setup: {
          id: 'setup-runtime',
          projectId: 'project-1',
          hostId: 'runtime:env-1'
        },
        repo: { id: 'repo-runtime', path: '/workspace/repo' }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        baseBranch: 'Jinwoo-H/setup-vercel-sandbox',
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'provisioning-vm' })
    )
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(prepareEphemeralVmWorkspaceTargetMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'github:stablyai/orca',
      workspaceName: 'feature',
      provisionId: 'creation-1',
      setupExistingFolder: store.setupProjectExistingFolder
    })
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[0]).toBe('repo-runtime')
    expect(createCall[1]).toBe('feature')
    expect(createCall[2]).toBeUndefined()
    expect(createCall).toContain('creation-1')
    expect(window.api.ephemeralVm.attachWorkspace).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      workspaceId: 'repo-runtime::/workspace/repo/worktree'
    })
    expect(store.refreshRuntimeEnvironmentStatus).toHaveBeenCalledWith('env-1')
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('appends stderr provisioning events for the active VM recipe create', async () => {
    let provisionEventCallback:
      | ((event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void)
      | null = null
    const unsubscribe = vi.fn()
    window.api.ephemeralVm.onProvisionEvent = vi.fn((callback) => {
      provisionEventCallback = callback
      return unsubscribe
    })
    prepareEphemeralVmWorkspaceTargetMock.mockImplementation(async () => {
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stderr',
        chunk: 'creating sandbox\n'
      })
      provisionEventCallback?.({
        provisionId: 'other-create',
        stream: 'stderr',
        chunk: 'ignore me\n'
      })
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stdout',
        chunk: '{"pairingCode":"secret"}'
      })
      return {
        ok: true,
        runtimeId: 'runtime-1',
        environmentId: 'env-1',
        stderr: '',
        warnings: [
          {
            id: 'recipe.result.endpoint.public_ws',
            message: 'Recipe pairing endpoint uses insecure public ws:// transport.',
            remediation: 'Use wss://.'
          }
        ],
        setup: {
          project: { id: 'project-1' },
          setup: {
            id: 'setup-runtime',
            projectId: 'project-1',
            hostId: 'runtime:env-1'
          },
          repo: { id: 'repo-runtime', path: '/workspace/repo' }
        }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(window.api.ephemeralVm.onProvisionEvent).toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({ provisioningLog: 'creating sandbox\n' })
    )
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        provisioningLog: expect.stringContaining(
          'Warning: Recipe pairing endpoint uses insecure public ws:// transport.'
        )
      })
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'pairingCode'
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'ignore me'
    )
  })
})

describe('staged background worktree creation', () => {
  it('can continue without revealing a staged create after background preflight', async () => {
    store.updatePendingWorktreeCreation.mockClear()
    store.createWorktree.mockClear()
    store.setActivePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()

    const request = makeRequest({ setupDecision: 'run' })
    const started = continueBackgroundWorktreeCreation('creation-1', request, {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        phase: 'fetching',
        request
      })
    )
    await Promise.resolve()
    expect(store.createWorktree).toHaveBeenCalledTimes(1)
    expect(store.setActivePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(store.setActiveView).not.toHaveBeenCalled()
    expect(store.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('keeps a backend startup terminal in the background after the user leaves', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1'
      },
      startupTerminal: { tabId: 'agent-tab', spawned: true }
    })

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await flushAsyncWorktreeCreation()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ activateCreatedTabs: false, backendStartupTerminalSpawned: true })
    )
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('opens only the setup tab despite templates when the composer choice is cleared', async () => {
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    const setup = { runnerScriptPath: '/repo/.orca/setup.sh', envVars: {} }
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
      setup,
      defaultTabs: { tabs: [{ title: 'Dev', command: 'pnpm dev' }], runCommands: true }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: null })

    continueBackgroundWorktreeCreation('creation-1', makeRequest({ setupOnly: true }))

    await vi.waitFor(() =>
      expect(activateAndRevealWorktree).toHaveBeenCalledWith(
        'wt-1',
        expect.objectContaining({ setup, providesInitialSurface: true })
      )
    )
    expect(store.createWorktree.mock.calls[0]?.at(-1)).toMatchObject({ setupOnly: true })
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[1]).not.toHaveProperty(
      'defaultTabs'
    )
  })

  it('seeds only setup despite templates when the user moved on before completion', async () => {
    store.activeView = 'tasks'
    const setup = { runnerScriptPath: '/repo/.orca/setup.sh', envVars: {} }
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
      setup,
      defaultTabs: { tabs: [{ title: 'Dev', command: 'pnpm dev' }], runCommands: true }
    })

    continueBackgroundWorktreeCreation('creation-1', makeRequest({ setupOnly: true }), {
      revealCreationSurface: false
    })

    await vi.waitFor(() =>
      expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
        store,
        'wt-1',
        undefined,
        setup,
        undefined,
        undefined,
        expect.objectContaining({ activateCreatedTabs: false, callerProvidesSurface: true })
      )
    )
  })

  it('seeds the backend-spawned agent tab, not the worktree default terminal tab', async () => {
    // Default tabs can be dev/log shells; backend startup terminal, not activation primaryTabId, identifies the agent.
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.tabsByWorktree = { 'wt-1': [{ id: 'dev-server' }, { id: 'agent-tab' }] }
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
      startupTerminal: { tabId: 'agent-tab', spawned: true }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'dev-server' })

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: 'claude --prefill x',
          expectedProcess: 'claude',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        },
        launchDraftPrompt: 'https://github.com/o/r/issues/12'
      })
    )

    await vi.waitFor(() => expect(store.seedNativeChatLaunchDraft).toHaveBeenCalled())
    expect(store.seedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'agent-tab' })
    )
    const createCall = store.createWorktree.mock.calls[0] as unknown[] | undefined
    expect(createCall?.[25]).toEqual({
      startupDraft: 'https://github.com/o/r/issues/12'
    })
  })

  it('toasts a staged create error after the user leaves the creation surface', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockRejectedValueOnce(new Error('create failed'))

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await flushAsyncWorktreeCreation()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        status: 'error'
      })
    )
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
