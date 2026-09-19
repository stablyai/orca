import { vi, type Mock } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

export function makeRequest(
  overrides: Partial<WorktreeCreationRequest> = {}
): WorktreeCreationRequest {
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

export function makePendingCreation(request: WorktreeCreationRequest): PendingWorktreeCreation {
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

type TestActiveView = 'terminal' | 'tasks'

export type CreationFlowStore = {
  settings: {
    activeRuntimeEnvironmentId: string | null
    experimentalNativeChat: boolean | undefined
    openAgentTabsInChatByDefault: boolean | undefined
  }
  activeView: TestActiveView
  activePendingCreationId: string | null
  repos: { id: string; connectionId: string | null }[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  beginPendingWorktreeCreation: Mock
  updatePendingWorktreeCreation: Mock
  removePendingWorktreeCreation: Mock
  updateWorktreeMeta: Mock
  removeWorktree: Mock
  setActivePendingWorktreeCreation: Mock
  setActiveView: Mock
  setSidebarOpen: Mock
  createWorktree: Mock
  setupProjectExistingFolder: Mock
  refreshRuntimeEnvironmentStatus: Mock
  seedNativeChatLaunchDraft: Mock
  setTabViewMode: Mock
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]>
  unifiedTabsByWorktree: Record<string, unknown>
}

/** The `@/store` stand-in shared by the creation-flow suites. */
export function makeCreationFlowStore(): CreationFlowStore {
  const store: CreationFlowStore = {
    settings: {
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: undefined,
      openAgentTabsInChatByDefault: undefined
    },
    activeView: 'terminal',
    activePendingCreationId: 'creation-1',
    repos: [{ id: 'repo-runtime', connectionId: null }],
    pendingWorktreeCreations: {},
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
    removeWorktree: vi.fn().mockResolvedValue({ ok: true }),
    setActivePendingWorktreeCreation: vi.fn(),
    setActiveView: vi.fn(),
    setSidebarOpen: vi.fn(),
    createWorktree: vi.fn(() => new Promise(() => {})),
    setupProjectExistingFolder: vi.fn(),
    refreshRuntimeEnvironmentStatus: vi.fn(),
    seedNativeChatLaunchDraft: vi.fn(),
    setTabViewMode: vi.fn(),
    tabsByWorktree: {},
    unifiedTabsByWorktree: {}
  }
  return store
}
