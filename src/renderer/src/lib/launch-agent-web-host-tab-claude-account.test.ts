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
    getState: () => ({ setActiveWorktree: vi.fn(), setActiveTabType: vi.fn() })
  }
}))

vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn()
}))

vi.mock('@/components/settings/agent-launch-settings-transport', () => ({
  hostSupportsLaunchChoices: vi.fn(async () => false)
}))

vi.mock('@/components/settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: vi.fn(async () => ({}))
}))

vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mockCreateTerminal
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
    buildStartup: () => ({
      startupPlan: STARTUP_PLAN,
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    }),
    prompt: '',
    promptDelivery: 'auto-submit',
    ...(relaunch ? { relaunch } : {})
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('carries the Claude account to the host even without a prompt', async () => {
  mockCreateTerminal.mockResolvedValue({ outcome: { status: 'created' } })
  await launch()
  expect(mockCreateTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      launchAgent: 'claude',
      launchConfig: expect.objectContaining({ claudeAccountId: 'acct-2' })
    })
  )
})

it('explains a pinned refusal and offers to start on the active account', async () => {
  const refusal = claudePinnedLaunchError('account-missing', 'Account acct-2 is not signed in.')
  mockCreateTerminal.mockResolvedValue({ outcome: { status: 'failed', message: refusal.message } })
  const relaunch = vi.fn()
  await launch(relaunch)
  const [message, options] = mockToastError.mock.calls[0]!
  expect(message).not.toContain('claude_pinned')
  expect(message).toContain('no longer signed in')
  options.action.onClick()
  expect(relaunch).toHaveBeenCalledWith(ACTIVE_CLAUDE_ACCOUNT)
})

it('shows the generic failure for an unrelated host error', async () => {
  mockCreateTerminal.mockResolvedValue({ outcome: { status: 'failed', message: 'host went away' } })
  await launch(vi.fn())
  expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Couldn't open a terminal"))
})
