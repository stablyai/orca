import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supported: true,
  call: vi.fn(),
  launch: vi.fn((_args: unknown): { tabId: string | null; runtimeLaunch?: Promise<unknown> } => ({
    tabId: 'terminal-tab'
  })),
  closeUnifiedTab: vi.fn(),
  toast: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: () => ({ settings: {}, closeUnifiedTab: mocks.closeUnifiedTab })
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: async () => mocks.supported,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeStartupForWorktree: () => ({
    command: 'codex resume thread-c',
    env: { CODEX_HOME: '/accounts/a/home' },
    providerSession: { key: 'session_id', id: 'thread-c' }
  })
}))

import { runNativeChatCliSwitch } from './native-chat-cli-switch-run'

const SWITCH = {
  sessionId: 'chat-1',
  workspaceId: 'wt-1',
  executionHostId: 'local',
  agent: 'codex' as const,
  chatTabId: 'chat-tab'
}
const SOURCE = {
  agent: 'codex',
  sourceAgent: 'codex',
  sessionId: 'thread-c',
  filePath: '/accounts/a/home/sessions/rollout-thread-c.jsonl',
  cwd: '/repo',
  codexHome: '/accounts/a/home',
  executionHostPlatform: 'darwin'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supported = true
  mocks.call.mockResolvedValue({ source: SOURCE })
})

it('stops the chat on its host, opens the same-id resume in its slot, leaves retirement to the admitted host launch', async () => {
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.switchToTerminal', {
    sessionId: 'chat-1'
  })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      worktreeId: 'wt-1',
      command: 'codex resume thread-c',
      env: { CODEX_HOME: '/accounts/a/home' },
      providerSession: { key: 'session_id', id: 'thread-c' },
      afterTabId: 'chat-tab',
      resumeOrigin: 'switch'
    })
  )
  // The committed host launch hides the source; a client receipt never stops today's native child.
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
})

it('never sends a switch to a host that does not advertise it', async () => {
  mocks.supported = false
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledOnce()
})

it('keeps the chat when the host refuses a busy chat, and says why', async () => {
  mocks.call.mockRejectedValue({
    data: {
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
    }
  })
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledWith('Wait for the reply to finish or stop it, then switch.')
})
