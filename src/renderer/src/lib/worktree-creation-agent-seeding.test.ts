import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  completeWorktreeCreation: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn(),
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))

const store = {
  activePendingCreationId: null as string | null,
  activeView: 'tasks' as 'tasks' | 'terminal',
  createWorktree: vi.fn(),
  pendingWorktreeCreations: {} as Record<string, unknown>,
  repos: []
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))
vi.mock('@/lib/worktree-creation-completion', () => ({
  completeWorktreeCreation: mocks.completeWorktreeCreation
}))
vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: mocks.ensureWebRuntimeWorktreeTerminalAfterWake
}))

import { executeWorktreeCreation } from './worktree-creation-flow-execute'

const request: WorktreeCreationRequest = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  agent: 'codex',
  agentLaunchRoute: 'terminal-tui',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null
}

describe('executeWorktreeCreation agent seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.activePendingCreationId = null
    store.activeView = 'tasks'
    store.pendingWorktreeCreations = { 'creation-1': { creationId: 'creation-1' } }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'worktree-1', repoId: request.repoId }
    })
  })

  it('routes a background agent selection through host-aware surface creation', async () => {
    await executeWorktreeCreation('creation-1', request)

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).toHaveBeenCalledOnce()
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).toHaveBeenCalledWith('worktree-1', {
      startup: undefined,
      agent: 'codex',
      activate: false
    })
    expect(mocks.completeWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTabId: null })
    )
  })

  it('passes the agent selection through an active reveal', async () => {
    store.activePendingCreationId = 'creation-1'
    store.activeView = 'terminal'
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    await executeWorktreeCreation('creation-1', request)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'worktree-1',
      expect.objectContaining({ agent: 'codex' })
    )
  })
})
