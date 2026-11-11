import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inspectRuntimeTerminalProcess = vi.fn()
const pasteDraftToAgentPtyWhenReady = vi.fn()

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: (...args: unknown[]) => inspectRuntimeTerminalProcess(...args)
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftToAgentPtyWhenReady: (...args: unknown[]) => pasteDraftToAgentPtyWhenReady(...args)
}))

import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'

describe('sendFollowupPromptWhenAgentReady', () => {
  beforeEach(() => {
    inspectRuntimeTerminalProcess.mockReset()
    pasteDraftToAgentPtyWhenReady.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    // dsh-TUI 0.19 runs DSH in-process, so its foreground is `dsh-tui`, not the configured `dsh`.
    { agent: 'dsh' as const, foreground: 'dsh-tui' },
    // ZCode's launch name is `zcode` while its configured expectedProcess is `zcode-cli`.
    { agent: 'zcode' as const, foreground: 'zcode' }
  ])('delivers when $agent owns the PTY as $foreground', async ({ agent, foreground }) => {
    inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: foreground,
      hasChildProcesses: true
    })

    await expect(
      sendFollowupPromptWhenAgentReady({ ptyId: 'pty-1', agent, prompt: 'hi' })
    ).resolves.toBe(true)
    expect(pasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-1', content: 'hi', agent })
    )
  })

  it("does not deliver while Agent Teams' generic `orca` launcher holds the PTY", async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'orca',
      hasChildProcesses: true
    })

    const delivered = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      agent: 'claude-agent-teams',
      prompt: 'hi'
    })
    await vi.runAllTimersAsync()

    await expect(delivered).resolves.toBe(false)
    expect(pasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()
  })
})
