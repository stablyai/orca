import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

type TestActiveView = 'terminal' | 'tasks' | 'multiplexer'

vi.mock('@/components/workspace-multiplexer/workspace-multiplexer-add-request', () => ({
  requestWorkspaceMultiplexerAdd: vi.fn()
}))

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
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
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { requestWorkspaceMultiplexerAdd } from '@/components/workspace-multiplexer/workspace-multiplexer-add-request'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.settings.experimentalNativeChat = undefined
  store.settings.openAgentTabsInChatByDefault = undefined
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

describe('multiplexer worktree creation', () => {
  it('keeps multiplexer creation visible and inserts the completed workspace', async () => {
    store.activeView = 'multiplexer'
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new', repoId: 'repo-1', hostId: 'ssh:box' }
    } as never)
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'tab-1' })
    runBackgroundWorktreeCreation(makeRequest())
    await vi.waitFor(() =>
      expect(requestWorkspaceMultiplexerAdd).toHaveBeenCalledWith({
        worktreeId: 'wt-new',
        executionHostId: 'ssh:box'
      })
    )
    expect(store.setActiveView).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-new',
      expect.objectContaining({ preserveActiveView: true })
    )
  })
})
