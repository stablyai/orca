import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

const kanbanSyncMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/kanban-workspace-start-sync', () => ({
  syncKanbanTaskAfterWorkspaceStart: kanbanSyncMock
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

describe('background worktree creation kanban sync', () => {
  const kanbanItem = {
    provider: 'kanban',
    type: 'issue',
    number: 0,
    title: 'K-1 Fix login',
    url: 'https://kanban.fpimi.ru/?task=K-1',
    kanbanIdentifier: 'K-1'
  } as const

  beforeEach(() => {
    vi.clearAllMocks()
    store.settings.activeRuntimeEnvironmentId = null
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.repos = []
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
    store.createWorktree.mockImplementation(() => new Promise(() => {}))
    kanbanSyncMock.mockReset()
  })

  it('syncs the Kanban card in the successful creation tail with the actual name and branch', async () => {
    store.createWorktree.mockResolvedValue({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        displayName: 'Widgets fix',
        branch: 'feature-x'
      }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        linkedWorkItem: kanbanItem,
        name: 'workspace'
      })
    )

    await vi.waitFor(() => expect(kanbanSyncMock).toHaveBeenCalled())
    expect(kanbanSyncMock).toHaveBeenCalledWith({
      linkedWorkItem: expect.objectContaining({ provider: 'kanban', kanbanIdentifier: 'K-1' }),
      projectName: 'Widgets fix',
      branch: 'feature-x'
    })
  })

  it('never syncs the Kanban card when background creation fails', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockRejectedValue(new Error('create failed'))

    runBackgroundWorktreeCreation(
      makeRequest({
        linkedWorkItem: kanbanItem,
        name: 'workspace'
      })
    )

    await flushAsyncWorktreeCreation()
    expect(kanbanSyncMock).not.toHaveBeenCalled()
  })
})