import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

// When activateAndRevealWorktree throws, its catch re-seeds the workspace surface. That seed
// must not claim the caller provides a surface: activation is the caller that would have, and
// it threw. Passing the flag sends an agent create with no startup plan into the zero-tab
// pre-seed branch of worktree-initial-terminal-seeding.ts, which queues commands and returns
// null — so the recovery recovers nothing and the workspace opens with no tabs.

const store = {
  settings: { activeRuntimeEnvironmentId: null as string | null },
  activeView: 'terminal' as const,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [{ id: 'repo-1', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  updatePendingWorktreeCreation: vi.fn(),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  createWorktree: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))
vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: vi.fn(
    async (_creationId: string, request: WorktreeCreationRequest) => request
  ),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(async () => undefined),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn(async () => undefined)
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/worktree-creation-agent-seeds'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'

const request = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  // An agent create with no startupPlan: the exact shape that reaches the zero-tab branch.
  agent: 'claude',
  startupPlan: null,
  pendingFirstAgentMessageRename: false,
  note: '',
  quickPrompt: '',
  quickTelemetry: null
} as WorktreeCreationRequest

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  store.tabsByWorktree = {}
  store.activePendingCreationId = 'creation-1'
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'fetching',
      status: 'creating',
      startedAt: 1,
      indeterminate: false,
      loaderVisible: true,
      request
    }
  }
  // No startupTerminal and no tabs, so the catch has no verified launch tab to adopt.
  store.createWorktree.mockResolvedValue({ worktree: { id: 'wt-1', repoId: 'repo-1' } })
  // Mirrors worktree-initial-terminal-seeding.ts: with callerProvidesSurface and nothing else
  // to seed, it queues setup/issue commands and returns null instead of creating a terminal.
  vi.mocked(ensureWorktreeHasInitialTerminal).mockImplementation(
    (...args: Parameters<typeof ensureWorktreeHasInitialTerminal>) =>
      args[6]?.callerProvidesSurface === true ? null : 'recovered-tab'
  )
  vi.mocked(activateAndRevealWorktree).mockImplementation(() => {
    throw new Error('activation exploded after publishing the worktree')
  })
})

describe('activation-failure recovery seeds a real surface', () => {
  it('recovers a terminal for an agent create with no startup plan', async () => {
    await executeWorktreeCreation('creation-1', request)

    expect(seedAgentTabStateAfterWorktreeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', primaryTabId: 'recovered-tab' })
    )
  })

  it('does not tell the seed that a caller provides the surface', async () => {
    await executeWorktreeCreation('creation-1', request)

    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ensureWorktreeHasInitialTerminal).mock.calls[0]?.[6]).not.toHaveProperty(
      'callerProvidesSurface'
    )
  })
})
