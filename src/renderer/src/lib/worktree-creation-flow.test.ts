import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const store = {
  settings: { activeRuntimeEnvironmentId: null as string | null },
  beginPendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {}))
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
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
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

describe('runBackgroundWorktreeCreation', () => {
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
})
