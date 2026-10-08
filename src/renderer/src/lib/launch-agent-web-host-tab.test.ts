import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: {}, closeTab: vi.fn(), setActiveTabType: vi.fn() })
  }
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebTerminalSurfaceTabId: () => true
}))

const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')

function launch() {
  return launchAgentInWebHostTab({
    agent: 'codex',
    worktreeId: 'wt-1',
    environmentId: 'env-1',
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    },
    prompt: 'fix it',
    promptDelivery: 'auto-submit',
    pastePromptAfterReady: null,
    submitPastedPrompt: false
  })
}

describe('a web host agent launch the host could not confirm', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.createWebRuntimeSessionTerminal.mockReset()
  })

  it('names the agent and says what to check instead of the host code', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      code: 'agent_session_operation_unknown',
      message: 'agent_session_operation_unknown'
    })
    await expect(launch()).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't confirm Codex started. Check this workspace's tabs before starting it again."
    )
  })

  it('keeps the host message for other failures', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    await launch()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The workspace is not connected to a remote Orca host.'
    )
  })
})
