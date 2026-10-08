import { beforeEach, expect, it, vi } from 'vitest'
import { claudePinnedLaunchError } from '../../../shared/claude/claude-pinned-launch-error'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'

const { mockCreateTerminal, mockToastError } = vi.hoisted(() => ({
  mockCreateTerminal: vi.fn(),
  mockToastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: {}, closeTab: vi.fn(), setActiveTabType: vi.fn() })
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mockCreateTerminal,
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebTerminalSurfaceTabId: () => true
}))

const STARTUP_PLAN: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: 'acct-2' }
}

async function launch(relaunch?: (claudeAccountId?: string) => void) {
  const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')
  return launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: 'repo-1::/repo/wt',
    environmentId: 'env-1',
    startupPlan: STARTUP_PLAN,
    prompt: '',
    promptDelivery: 'auto-submit',
    pastePromptAfterReady: null,
    submitPastedPrompt: false,
    ...(relaunch ? { relaunch } : {})
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('carries the Claude account to the host even without a prompt', async () => {
  mockCreateTerminal.mockResolvedValue({ status: 'created' })
  await launch()
  expect(mockCreateTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      launchConfig: expect.objectContaining({ claudeAccountId: 'acct-2' })
    })
  )
})

it('explains a pinned refusal and offers to start on the active account', async () => {
  const refusal = claudePinnedLaunchError('account-missing', 'Account acct-2 is not signed in.')
  mockCreateTerminal.mockResolvedValue({ status: 'failed', message: refusal.message })
  const relaunch = vi.fn()
  await launch(relaunch)
  const [message, options] = mockToastError.mock.calls[0]!
  expect(message).not.toContain('claude_pinned')
  expect(message).toContain('no longer signed in')
  options.action.onClick()
  expect(relaunch).toHaveBeenCalledWith(ACTIVE_CLAUDE_ACCOUNT)
})

it('keeps the host message for an unrelated failure', async () => {
  mockCreateTerminal.mockResolvedValue({ status: 'failed', message: 'host went away' })
  await launch(vi.fn())
  expect(mockToastError).toHaveBeenCalledWith('host went away')
})
