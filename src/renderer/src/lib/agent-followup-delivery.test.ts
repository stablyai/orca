import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftToAgentPtyWhenReady: vi.fn()
}))

// Pip console-script agents expose python/python3 foreground comm rather than their agent name.
const INTERPRETER_WRAPPED_AGENTS = [
  { agent: 'aider', expectedProcess: TUI_AGENT_CONFIG.aider.expectedProcess }
] as const

// The prompt is pasted and submitted through composer readiness, never typed with a raw CR.
const SUBMITTED_PASTE = {
  ptyId: 'pty-1',
  content: 'ship it',
  agent: 'aider',
  submit: true,
  forcePaste: true
}

describe('sendFollowupPromptWhenAgentReady — interpreter-wrapped agents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('globalThis', globalThis)
    // Deliver the prompt write eagerly so the test does not depend on retries.
    vi.mocked(pasteDraftToAgentPtyWhenReady).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  for (const { agent, expectedProcess } of INTERPRETER_WRAPPED_AGENTS) {
    it(`types the prompt once ${agent} is up behind a python3 wrapper with a live child`, async () => {
      // A live interpreter child must establish readiness even without the exact agent name.
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'python3',
        hasChildProcesses: true
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        agent,
        expectedProcess,
        prompt: 'ship it'
      })

      await vi.advanceTimersByTimeAsync(4 * 150)
      const delivered = await delivery

      expect(delivered).toBe(true)
      expect(pasteDraftToAgentPtyWhenReady).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(SUBMITTED_PASTE)
      )
    })

    it(`still refuses to type into a bare ${agent} shell foreground`, async () => {
      // A plain shell without a non-shell child must never receive user text.
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'zsh',
        hasChildProcesses: false
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        agent,
        expectedProcess,
        prompt: 'ship it'
      })

      await vi.advanceTimersByTimeAsync(29 * 150)
      const delivered = await delivery

      expect(delivered).toBe(false)
      expect(pasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()
    })

    it(`refuses to type into a ${agent} wrapper without a live child`, async () => {
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'python3',
        hasChildProcesses: false
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        agent,
        expectedProcess,
        prompt: 'ship it'
      })

      await vi.advanceTimersByTimeAsync(29 * 150)
      const delivered = await delivery

      expect(delivered).toBe(false)
      expect(pasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()
    })
  }

  it('types immediately when the resolver already returns the agent name (local ps path)', async () => {
    // Preserve exact-name matching when local process inspection resolves the interpreter to its agent.
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })

    const delivered = await sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      agent: 'aider',
      expectedProcess: 'aider',
      prompt: 'ship it'
    })

    expect(delivered).toBe(true)
    expect(pasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith(
      expect.objectContaining(SUBMITTED_PASTE)
    )
  })

  it('pastes nothing when the agent left the terminal during the readiness wait', async () => {
    vi.mocked(inspectRuntimeTerminalProcess)
      .mockResolvedValueOnce({ foregroundProcess: 'aider', hasChildProcesses: true })
      .mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false })
    // Run the real last check the paste would make once the composer reads ready.
    vi.mocked(pasteDraftToAgentPtyWhenReady).mockImplementation(async ({ beforePaste }) =>
      beforePaste ? await beforePaste() : true
    )

    const delivered = await sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      agent: 'aider',
      expectedProcess: 'aider',
      prompt: 'ship it'
    })

    expect(delivered).toBe(false)
  })
})
