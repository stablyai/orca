import { beforeEach, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const pendingWorktreeCreations: Record<string, PendingWorktreeCreation> = {}
const store = {
  settings: {},
  activeView: 'terminal',
  activePendingCreationId: 'creation-1',
  repos: [],
  pendingWorktreeCreations,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    pendingWorktreeCreations[entry.creationId] = entry
  }),
  updatePendingWorktreeCreation: vi.fn(),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: 'tab-1' }))
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { continueBackgroundWorktreeCreation } from './worktree-creation-flow'

beforeEach(() => {
  vi.clearAllMocks()
})

function promptedClaudeRequest(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'claude',
    agentLaunchRoute: 'terminal-tui',
    pendingFirstAgentMessageRename: false,
    note: '',
    quickPrompt: 'fix the bug',
    quickTelemetry: {
      agent_kind: 'claude-code',
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    },
    startupPlan: {
      agent: 'claude',
      launchCommand: '/desktop/claude',
      expectedProcess: 'claude',
      followupPrompt: 'fix the bug',
      launchConfig: { agentCommand: '/desktop/claude', agentArgs: '', agentEnv: {} }
    }
  }
}

it('never runs the desktop plan when the host that planned the launch did not start it', async () => {
  store.createWorktree.mockResolvedValueOnce({
    worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
    warning: 'Host could not start claude.',
    hostPlannedStartup: true
  })

  const request = promptedClaudeRequest()
  pendingWorktreeCreations['creation-1'] = {
    creationId: 'creation-1',
    phase: 'fetching',
    status: 'creating',
    startedAt: 1,
    indeterminate: true,
    loaderVisible: true,
    request
  }
  continueBackgroundWorktreeCreation('creation-1', request)

  await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())
  expect(store.createWorktree.mock.calls[0]?.[25]).toMatchObject({
    hostAgentLaunch: {
      agent: 'claude',
      prompt: 'fix the bug',
      launchSource: 'new_workspace_composer'
    }
  })
  const activation = vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[1]
  // Neither the desktop plan nor the window's agent recovery, which would drop the prompt.
  expect(activation).not.toHaveProperty('startup')
  expect(activation).not.toHaveProperty('agent')
  expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    "Couldn't confirm Claude started. Check its terminal before trying again."
  )
})
