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
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [] as { id: string; connectionId: string | null }[],
  worktreesByRepo: {} as Record<string, { id: string; repoId: string; branch?: string }[]>,
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
  activateAndRevealWorktree: vi.fn(() => false),
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
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-activation'
import { continueBackgroundWorktreeCreation } from './worktree-creation-flow'

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

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.activeView = 'tasks'
  store.activePendingCreationId = 'creation-1'
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
  store.repos = [{ id: 'repo-1', connectionId: null }]
  store.worktreesByRepo = {
    'repo-1': [{ id: 'parent-1', repoId: 'repo-1', branch: 'feat/parent' }]
  }
  store.createWorktree.mockResolvedValueOnce({ worktree: { id: 'wt-1', repoId: 'repo-1' } })
})

describe('child workspace parent at create time', () => {
  // Why: read the options bag off the end rather than by index — createWorktree
  // takes 26 positional parameters, so a fixed index silently drifts.
  function createCallParts(): { baseBranch: unknown; options: unknown } {
    const args = store.createWorktree.mock.calls[0] as unknown[]
    return { baseBranch: args[2], options: args.at(-1) }
  }

  it('threads the parent branch and lineage option into the create call', async () => {
    const started = continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ parentWorktreeId: 'parent-1' }),
      { revealCreationSurface: false }
    )

    expect(started).toBe(true)
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
    const { baseBranch, options } = createCallParts()
    expect(baseBranch).toBe('feat/parent')
    expect(options).toMatchObject({ parentWorktreeId: 'parent-1' })
  })

  it('lets an explicit Start-from base win over the parent branch', async () => {
    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ parentWorktreeId: 'parent-1', baseBranch: 'release/1.0' }),
      { revealCreationSurface: false }
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
    const { baseBranch, options } = createCallParts()
    expect(baseBranch).toBe('release/1.0')
    expect(options).toMatchObject({ parentWorktreeId: 'parent-1' })
  })

  it('drops the parent when it was deleted before submit', async () => {
    store.worktreesByRepo = { 'repo-1': [] }

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ parentWorktreeId: 'parent-1' }),
      { revealCreationSurface: false }
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
    const { baseBranch, options } = createCallParts()
    expect(baseBranch).toBeUndefined()
    expect(options).not.toHaveProperty('parentWorktreeId')
  })

  it('drops the parent when the composer switched to another repo', async () => {
    store.repos = [
      { id: 'repo-1', connectionId: null },
      { id: 'repo-2', connectionId: null }
    ]
    store.worktreesByRepo = {
      'repo-2': [{ id: 'parent-2', repoId: 'repo-2', branch: 'feat/other' }]
    }

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({ parentWorktreeId: 'parent-2' }),
      { revealCreationSurface: false }
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
    const { baseBranch, options } = createCallParts()
    expect(baseBranch).toBeUndefined()
    expect(options).not.toHaveProperty('parentWorktreeId')
  })
})
