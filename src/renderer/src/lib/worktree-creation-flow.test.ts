import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  settings: { activeRuntimeEnvironmentId: null as string | null },
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
  refreshRuntimeEnvironmentStatus: vi.fn()
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
  activateAndRevealWorktree: vi.fn(() => false),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { toast } from 'sonner'
import {
  activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal
} from '@/lib/worktree-activation'
import { queueNewWorkspaceTerminalFocus } from '@/lib/new-workspace-terminal-focus'
import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from './worktree-creation-flow'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow.ts'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
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

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
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

  it('uses the captured repo-owner progress mode instead of focused runtime state', () => {
    store.settings.activeRuntimeEnvironmentId = null
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest({ worktreeCreateProgressMode: 'indeterminate' }))

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        indeterminate: true,
        request: expect.objectContaining({
          worktreeCreateProgressMode: 'indeterminate'
        })
      })
    )
  })

  it('falls back to focused runtime state for legacy captured requests', () => {
    store.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest())

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        indeterminate: true,
        request: expect.not.objectContaining({
          worktreeCreateProgressMode: expect.any(String)
        })
      })
    )
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

  it('preserves provider-backed VM start points after provisioning', async () => {
    store.repos = [{ id: 'repo-1', connectionId: null }] as never
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
          projectId: 'github:stablyai/orca'
        },
        baseBranch: 'abc123',
        compareBaseRef: 'refs/remotes/origin/main',
        linkedPR: 42
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[0]).toBe('repo-runtime')
    expect(createCall[2]).toBe('abc123')
    expect(createCall[24]).toBe('refs/remotes/origin/main')
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
  it('shows a pending preparing row before async preflight finishes', () => {
    store.beginPendingWorktreeCreation.mockClear()

    const creationId = beginBackgroundWorktreePreparation(makeRequest({ displayName: 'Issue 42' }))

    expect(creationId).toBe('creation-1')
    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        phase: 'preparing',
        request: expect.objectContaining({ displayName: 'Issue 42' })
      })
    )
  })

  it('replaces the staged request before the create starts', async () => {
    store.updatePendingWorktreeCreation.mockClear()
    store.createWorktree.mockClear()
    store.setActivePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()

    const request = makeRequest({ setupDecision: 'run' })
    const started = continueBackgroundWorktreeCreation('creation-1', request)

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
    const createCall = store.createWorktree.mock.calls[0] as unknown[] | undefined
    expect(createCall).toBeDefined()
    expect(createCall?.[0]).toBe('repo-1')
    expect(createCall?.[1]).toBe('feature')
    expect(createCall?.[3]).toBe('run')
    expect(createCall?.[18]).toBe('creation-1')
    expect(store.setActivePendingWorktreeCreation).toHaveBeenCalledWith('creation-1')
    expect(store.setActiveView).toHaveBeenCalledWith('terminal')
    expect(store.setSidebarOpen).toHaveBeenCalledWith(true)
  })

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

  it('does not reveal a completed staged create after the user leaves the creation surface', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1'
      }
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
      { activateCreatedTabs: false }
    )
    expect(queueNewWorkspaceTerminalFocus).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('reveals the completed workspace after the user switches to another workspace', async () => {
    let resolveCreate!: (result: { worktree: { id: string; repoId: string } }) => void
    store.createWorktree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
    // Why: selecting a real workspace clears only the pending surface pointer;
    // completion should still finish the task-launch handoff once it is ready.
    store.activePendingCreationId = null
    resolveCreate({ worktree: { id: 'wt-1', repoId: 'repo-1' } })
    await flushAsyncWorktreeCreation()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      sidebarRevealBehavior: 'auto'
    })
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('does not reveal a workspace cancelled during post-create trust preflight', async () => {
    let resolveTrust!: () => void
    const markTrusted = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTrust = resolve
        })
    )
    globalThis.window = { api: { agentTrust: { markTrusted } } } as never
    store.repos = [{ id: 'repo-1', connectionId: null }]
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }
    })

    const started = continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ agent: 'codex' }),
      { revealCreationSurface: false }
    )

    expect(started).toBe(true)
    await vi.waitFor(() => expect(markTrusted).toHaveBeenCalledTimes(1))
    delete store.pendingWorktreeCreations['creation-1']
    store.activePendingCreationId = null
    resolveTrust()
    await vi.waitFor(() => expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledTimes(1))

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  // Why: one-click "Start workspace from issue" commonly backgrounds, so the
  // user-moved-on path is the common delivery for the repo's issue command; it
  // must thread through as the 5th positional arg, not be dropped to undefined.
  it('threads the request issue command into the background terminal seed', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1'
      }
    })

    const started = continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ issueCommand: { command: 'gh issue view 42' } }),
      { revealCreationSurface: false }
    )

    expect(started).toBe(true)
    // Why: vi.waitFor instead of a fixed microtask flush — the await count in
    // executeWorktreeCreation grows over time (e.g. VM preflight), and a fixed
    // flush silently starves this assertion in merged builds.
    await vi.waitFor(() =>
      expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
        store,
        'wt-1',
        undefined,
        undefined,
        { command: 'gh issue view 42' },
        undefined,
        { activateCreatedTabs: false }
      )
    )
  })

  // Why: the still-watching path activates the worktree directly, so the issue
  // command must reach activateAndRevealWorktree too — both branches carry it.
  it('threads the request issue command into the active reveal', async () => {
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.createWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/wt-1'
      }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'tab-1' })

    const started = continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ issueCommand: { command: 'gh issue view 42' } })
    )

    expect(started).toBe(true)
    await vi.waitFor(() =>
      expect(activateAndRevealWorktree).toHaveBeenCalledWith(
        'wt-1',
        expect.objectContaining({ issueCommand: { command: 'gh issue view 42' } })
      )
    )
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
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

describe('worktree creation flow agent trust preflight', () => {
  it('forwards the repo SSH connection id when pre-marking agent trust', () => {
    const preflight = sourceBetween(
      FLOW_SOURCE,
      'async function preflightAgentTrust',
      'async function executeWorktreeCreation'
    )
    const createFlow = sourceBetween(
      FLOW_SOURCE,
      'const backendSpawned = result.startupTerminal?.spawned === true',
      '// `createWorktree` already inserted the real worktree row'
    )

    expect(preflight).toContain('connectionId?: string | null')
    expect(preflight).toContain('...(connectionId ? { connectionId } : {})')
    expect(createFlow).toContain('repoConnectionId')
    expect(createFlow).toContain('repo.id === worktree.repoId')
    expect(createFlow).toContain(
      'await preflightAgentTrust(preparedRequest, worktree.path, repoConnectionId)'
    )
  })
})
