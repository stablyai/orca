import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const initialState: {
  settings: { activeRuntimeEnvironmentId: string | null }
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  activePendingCreationId: string | null
} = {
  settings: { activeRuntimeEnvironmentId: null },
  pendingWorktreeCreations: {},
  activePendingCreationId: 'creation-shown'
}

const store = {
  ...initialState,
  beginPendingWorktreeCreation: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-new'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
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
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: vi.fn()
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

describe('runBackgroundWorktreeCreation without revealing the creation surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingWorktreeCreations = {}
  })

  it('starts the creation but keeps whatever already owns the center pane', () => {
    runBackgroundWorktreeCreation(makeRequest(), { revealCreationSurface: false })

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ creationId: 'creation-new' })
    )
    expect(store.setActivePendingWorktreeCreation).toHaveBeenCalledWith('creation-shown')
    expect(store.setActiveView).not.toHaveBeenCalled()
    expect(store.setSidebarOpen).not.toHaveBeenCalled()
  })
})
