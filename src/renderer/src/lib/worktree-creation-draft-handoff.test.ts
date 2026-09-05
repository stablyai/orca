import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  bind: vi.fn(),
  activate: vi.fn(),
  complete: vi.fn()
}))
const store = vi.hoisted(() => ({
  activeView: 'terminal',
  activePendingCreationId: 'creation',
  pendingWorktreeCreations: { creation: {} },
  repos: []
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ ...store, createWorktree: calls.create }) }
}))
vi.mock('./workspace-creation-drafts/creation-draft-session', () => ({
  bindCreationDraft: calls.bind
}))
vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: async (_id: string, request: WorktreeCreationRequest) => request,
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn()
}))
vi.mock('@/lib/agent-trust-preflight', () => ({ preflightAgentTrust: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: calls.activate }))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/worktree-creation-completion', () => ({ completeWorktreeCreation: calls.complete }))
vi.mock('@/lib/worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: vi.fn()
}))
vi.mock('@/lib/worktree-creation-structured-recovery', () => ({
  markStructuredWorktreeLaunchUnconfirmed: vi.fn()
}))

import { executeWorktreeCreation } from './worktree-creation-flow-execute'

beforeEach(() => {
  vi.clearAllMocks()
  calls.create.mockResolvedValue({
    worktree: { id: 'workspace', repoId: 'repo', path: '/repo/workspace' },
    startupTerminal: { handle: 'original', tabId: 'agent-tab', spawned: true }
  })
  calls.activate.mockReturnValue({ primaryTabId: 'agent-tab' })
})

describe('ordinary creation draft handoff', () => {
  it('binds the original startup terminal before activation without preparing a workspace', async () => {
    calls.activate.mockImplementationOnce(() => {
      expect(calls.bind).toHaveBeenCalledWith('creation', {
        worktreeId: 'workspace',
        terminalHandle: 'original',
        tabId: 'agent-tab'
      })
      return { primaryTabId: 'agent-tab' }
    })
    await executeWorktreeCreation('creation', {
      repoId: 'repo',
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    })
    expect(calls.create).toHaveBeenCalledOnce()
    expect(calls.create.mock.calls[0][25]).toMatchObject({ callerOwnsCompletion: true })
    expect(calls.activate).toHaveBeenCalledOnce()
    expect(calls.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        startupTerminalTabId: 'agent-tab',
        backendSpawned: true
      })
    )
  })
})
